import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
  isSessionMissingDispatchError,
  settleCronRunTerminalOutcome,
} from "@zcode/services/node";
import { IZCodeTaskService } from "@zcode/services";
import type { ServiceCollection } from "@zcode/services";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import { formatModelPickerValue, resolveWorkspaceKey } from "@zcode/shared";
import type { TraceId } from "@zcode/shared";

/**
 * 独立 Server 的 scheduled automation 循环。
 *
 * 背景：automations 行只存在于创建它的那台机器的 tasks-index DB 里。desktop 的 cron
 * scheduler 只轮询本机那份文件（getTasksIndexDatabasePath），因此在远端 devcontainer
 * 里创建的 automation 永远不会被任何调度器认领 —— 手动「立即运行」曾是唯一真正跑起来
 * 的路径（现象：automation_runs 全为 trigger=manual，scheduled_run_count 恒为 0）。
 *
 * 这里把同一套调度语义搬进远端常驻进程：
 * - 20s 轮询 + claimDue 原子认领（BEGIN IMMEDIATE + running 0→1）
 * - misfire 宽限 5 分钟：停机/休眠期间错过的窗口记 skipped 不补跑；一次性任务错过即终态
 * - transient 派发失败按 retry_at 退避（DISPATCH_RETRY_* / 最多 DISPATCH_MAX_ATTEMPTS）
 * - 派发成功按 computeAutomationNextRunAt 推进 next_run_at
 *
 * 与 desktop scheduler 的差异（有意为之）：没有 parentPort 回执，直接在本进程用
 * task service 建任务/发 prompt；结算原语与 session/manualAutomationDispatcher.ts 共用。
 */

/** 轮询间隔：cron 最小粒度是分钟，20s 足以按时命中且开销低。 */
export const SCHEDULER_POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值视为错过窗口（容器停机/休眠）。
 * 需明显大于一次正常轮询延迟，又能覆盖短暂卡顿。
 */
export const SCHEDULER_MISFIRE_GRACE_MS = 5 * 60_000;

export interface AutomationSchedulerLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface AutomationSchedulerOptions {
  services: ServiceCollection;
  /** 测试注入；生产默认 20s，下限 1s 防止误配忙轮询。 */
  pollIntervalMs?: number;
  misfireGraceMs?: number;
  repo?: AutomationRepo;
  now?: () => number;
  log?: AutomationSchedulerLogger;
}

export interface AutomationScheduler {
  /** 启动轮询（立即跑一轮，不等第一个 interval）。重复调用幂等。 */
  start(): void;
  /** 停轮询、释放本进程在途认领与订阅。 */
  dispose(): Promise<void>;
  /** 立即跑一轮；并发调用复用同一轮。 */
  tick(): Promise<void>;
}

function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

export function createAutomationScheduler(
  options: AutomationSchedulerOptions,
): AutomationScheduler {
  const repo = options.repo ?? new AutomationRepo();
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? SCHEDULER_POLL_INTERVAL_MS);
  const misfireGraceMs = options.misfireGraceMs ?? SCHEDULER_MISFIRE_GRACE_MS;
  const log: AutomationSchedulerLogger = options.log ?? {
    info: (message) => console.info(`[automation-scheduler] ${message}`),
    warn: (message, error) => console.warn(`[automation-scheduler] ${message}`, error),
    error: (message, error) => console.error(`[automation-scheduler] ${message}`, error),
  };

  /** runId → 在途派发上下文；dispose 时据此释放认领。 */
  const inFlight = new Map<string, { automationId: string; workspaceKey: string }>();
  /** runId → 终态订阅；派发失败/退出时必须显式 dispose。 */
  const terminalSubscriptions = new Map<string, { dispose(): void }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let disposed = false;

  async function dispatchRun(
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
    workspaceKey: string,
  ): Promise<{ taskId: string }> {
    const tasks = options.services.getOptional(IZCodeTaskService);
    if (!tasks) throw new Error("ZCode task service is not initialized.");
    const promptTraceId = run.runId as TraceId;
    let task = automation.targetTaskId
      ? { taskId: automation.targetTaskId }
      : await tasks.createTask({
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
        await tasks.resumeTask({
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
        log.warn(
          `automation 绑定会话已不存在，自动重建并重绑 automation=${automation.automationId} oldTaskId=${automation.targetTaskId}`,
          error,
        );
        const replacement = await tasks.createTask({
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

    const identity = {
      runId: run.runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt: run.scheduledAt ?? null,
      trigger: "schedule" as const,
    };
    // scheduled run 没有 manual claim heartbeat：终态必须由这条订阅收口。
    const subscription = tasks.onDynamicTaskTerminalOutcome(task.taskId)((result) => {
      if (result.inputId !== promptTraceId) return;
      void settleCronRunTerminalOutcome({
        ...identity,
        outcome: result.outcome,
        error: result.error,
        repo,
        logWarn: (message, error) => log.warn(message, error),
      })
        .then(() => repo.releaseClaim(automation.automationId))
        .catch((error: unknown) => log.warn("scheduled run 终态结算失败", error));
      subscription.dispose();
      terminalSubscriptions.delete(run.runId);
    });
    terminalSubscriptions.set(run.runId, subscription);

    await tasks.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: automation.prompt,
      clientMode: "desktop-continuous",
      automationId: automation.automationId,
    });
    return { taskId: task.taskId };
  }

  async function handleClaimed(automation: ZCodeAutomation, at: number): Promise<void> {
    const scheduledAt = resolveScheduledAt(automation, at);
    const runId = buildRunId(automation.automationId, scheduledAt);
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划时间已远早于 now → 错过窗口，跳过不补跑。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= at - misfireGraceMs;
    if (missed) {
      const finalize = isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, at);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "server_stopped_or_asleep",
        nextRunAt,
        finalize,
      });
      log.info(
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${
          finalize ? " finalized=one-shot" : ""
        }`,
      );
      return;
    }

    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
    });
    inFlight.set(runId, { automationId: automation.automationId, workspaceKey });
    const run = await repo.getRun(runId);
    if (!run) {
      inFlight.delete(runId);
      await repo.releaseClaim(automation.automationId);
      log.warn(`scheduled run 台账缺失，已释放认领 automation=${automation.automationId}`);
      return;
    }

    try {
      const dispatched = await dispatchRun(automation, run, workspaceKey);
      await repo.markRunDispatch({
        runId,
        dispatchStatus: "dispatched",
        sessionId: dispatched.taskId,
      });
      const current = await repo.get(automation.automationId);
      const nextRunAt = current ? computeAutomationNextRunAt(current, at) : null;
      await repo.markDispatched(automation.automationId, { dispatchedAt: at, nextRunAt });
      inFlight.delete(runId);
      log.info(
        `scheduled run dispatched automation=${automation.automationId} runId=${runId} taskId=${dispatched.taskId}`,
      );
    } catch (error) {
      inFlight.delete(runId);
      // 派发失败时终态订阅不会触发，必须在这里收口并退避。
      terminalSubscriptions.get(runId)?.dispose();
      terminalSubscriptions.delete(runId);
      const message = error instanceof Error ? error.message : String(error);
      await repo.markRunDispatch({
        runId,
        dispatchStatus: "failed_to_dispatch",
        error: message,
      });
      const current = await repo.get(automation.automationId);
      await repo.markDispatchFailed(automation.automationId, {
        failedAt: at,
        error: message,
        kind: "transient",
        nextRunAt: current ? computeAutomationNextRunAt(current, at) : null,
      });
      log.error(`scheduled run dispatch failed automation=${automation.automationId}`, error);
    }
  }

  async function runTick(): Promise<void> {
    if (disposed || ticking) return;
    ticking = true;
    try {
      const at = now();
      const claimed = await repo.claimDue(at);
      for (const automation of claimed) {
        try {
          await handleClaimed(automation, at);
        } catch (error) {
          // 单条失败不拖垮整轮；认领会在 CLAIM_STALE 之后回收。
          log.error(
            `handle claimed automation failed automation=${automation.automationId}`,
            error,
          );
          await repo.releaseClaim(automation.automationId).catch(() => undefined);
        }
      }
    } catch (error) {
      log.error("scheduler tick failed", error);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (disposed || timer) return;
      void runTick();
      timer = setInterval(() => void runTick(), pollIntervalMs);
      // 常驻进程的轮询不应单独阻止事件循环退出；dispose 会清掉计时器。
      timer.unref?.();
      log.info(`started pollIntervalMs=${pollIntervalMs} misfireGraceMs=${misfireGraceMs}`);
    },
    async tick() {
      await runTick();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const subscription of terminalSubscriptions.values()) {
        try {
          subscription.dispose();
        } catch {
          // 退出路径尽力而为
        }
      }
      terminalSubscriptions.clear();
      for (const context of inFlight.values()) {
        try {
          await repo.releaseClaim(context.automationId);
        } catch {
          // 退出路径尽力而为
        }
      }
      inFlight.clear();
    },
  };
}
