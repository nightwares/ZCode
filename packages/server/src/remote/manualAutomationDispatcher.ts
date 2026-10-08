import { formatModelPickerValue, resolveWorkspaceKey } from "@zcode/shared";
import type { TraceId, ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import { IZCodeTaskService } from "@zcode/services";
import {
  AutomationRepo,
  createLocalServices,
  isSessionMissingDispatchError,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
  startManualClaimHeartbeat,
} from "@zcode/services/node";

type LocalServices = ReturnType<typeof createLocalServices>;

const logWarn = (message: string, error: unknown) => {
  console.warn("[manual-automation]", message, error);
};

/**
 * 远端 server（devcontainer/SSH/WSL 内的 zcode-server）的 manual automation 派发器。
 * desktop host 的 dispatchManualAutomationRun 依赖窗口会话 registry 与 parentPort 遥测，
 * 这里是它的最小等价实现：直接用本环境自己的 task service 建任务并发 prompt，
 * 结算语义（manual claim 心跳 / 终态回填 / 派发失败释放）与 desktop 共用同一套
 * automationRunLifecycle 原语，避免两份实现漂移。
 *
 * 与 desktop 的差异（有意为之）：
 * - model selection 直接使用 automation 上的长期配置，不经过账号/Registry 重解释；
 * - 不订阅 Bot 回推（远端环境没有 bots delivery 通道）。
 */
export function createManualAutomationDispatcher(
  services: LocalServices,
): (params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }) => Promise<void> {
  const repo = new AutomationRepo();

  return async ({ automation, run }) => {
    const zcodeTaskService = services.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      throw new Error("ZCode task service is not initialized.");
    }

    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const identity = {
      runId: run.runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt: null,
      trigger: "manual" as const,
    };
    const promptTraceId = run.runId as TraceId;
    let terminalSubscription: { dispose(): void } | null = null;
    let claimHeartbeat: { dispose(): void } | null = null;

    try {
      let task = automation.targetTaskId
        ? { taskId: automation.targetTaskId }
        : await zcodeTaskService.createTask({
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity ?? undefined,
            model: formatModelPickerValue(automation.modelSelection),
            mode: automation.mode,
            thoughtLevel: automation.modelSelection?.options?.reasoningLevel,
            automationId: automation.automationId,
          });
      if (automation.targetTaskId) {
        // 绑定会话通常不处于 active；与 desktop 派发一致，先恢复再应用运行参数。
        try {
          await zcodeTaskService.resumeTask({
            taskId: task.taskId,
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity ?? undefined,
            model: formatModelPickerValue(automation.modelSelection),
            thoughtLevel: automation.modelSelection?.options?.reasoningLevel,
            automationId: automation.automationId,
          });
        } catch (error) {
          if (!isSessionMissingDispatchError(error)) throw error;
          // 绑定会话被删除：自动新建会话并重绑（与 desktop 派发同一自愈语义）。
          logWarn(
            `automation 绑定会话已不存在，自动重建并重绑 automation=${automation.automationId} oldTaskId=${automation.targetTaskId}`,
            error,
          );
          const replacement = await zcodeTaskService.createTask({
            workspacePath: automation.workspacePath,
            workspaceIdentity: automation.workspaceIdentity ?? undefined,
            model: formatModelPickerValue(automation.modelSelection),
            mode: automation.mode,
            thoughtLevel: automation.modelSelection?.options?.reasoningLevel,
            automationId: automation.automationId,
          });
          await repo.updateTargetTask(automation.automationId, workspaceKey, replacement.taskId);
          task = { taskId: replacement.taskId };
        }
      }

      terminalSubscription = zcodeTaskService.onDynamicTaskTerminalOutcome(task.taskId)(
        (result) => {
          if (result.inputId !== promptTraceId) return;
          void settleCronRunTerminalOutcome({
            ...identity,
            outcome: result.outcome,
            error: result.error,
            repo,
            logWarn,
          });
          void zcodeTaskService.setTaskUnread({
            taskId: task.taskId,
            workspacePath: automation.workspacePath,
            ...(automation.workspaceIdentity
              ? { workspaceIdentity: automation.workspaceIdentity }
              : {}),
            unread: true,
          });
          terminalSubscription?.dispose();
          claimHeartbeat?.dispose();
        },
      );
      claimHeartbeat = startManualClaimHeartbeat({ ...identity, repo, logWarn });

      await zcodeTaskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId,
        content: automation.prompt,
        clientMode: "desktop-continuous",
        automationId: automation.automationId,
      });
    } catch (error) {
      terminalSubscription?.dispose();
      claimHeartbeat?.dispose();
      await settleManualDispatchFailureBestEffort({
        ...identity,
        repo,
        dispatchError: error,
        logWarn,
      });
      throw error;
    }
  };
}
