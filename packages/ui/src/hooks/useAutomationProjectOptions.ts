import { useMemo } from "react";
import type { WorkspacePurpose } from "@zcode/shared";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { resolveWorkspaceTabDisplayName } from "@/lib/workspaceDisplayName.js";
import { useWorkspaceDisplayNameOverrides } from "@/hooks/useWorkspaceDisplayName.js";

interface AutomationProjectOption {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remote?: boolean;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function isRemoteAutomationWorkspace(tab: WorkspaceTabState | undefined): boolean {
  return Boolean(tab?.remoteSessionId || tab?.remoteTarget || tab?.workspaceIdentity);
}

interface AutomationProjectOptionsConfig {
  includeConversationWorkspace?: boolean;
  /**
   * 定时任务允许把已连接的远端 workspace（devcontainer/SSH/WSL）作为目标：
   * 桌面端 scheduler 会把派发路由到持有该会话的窗口 host，容器离线时按 transient 退避重试。
   * 闲时任务（off-peak）保持仅本地——远端运行时模型不在支持范围。
   */
  includeRemoteWorkspaces?: boolean;
}

function resolveAutomationProjectOptions(
  workspaceTabs: WorkspaceTabState[],
  config: AutomationProjectOptionsConfig = {},
  workspaceDisplayNameOverrides?: Record<string, string> | null,
): AutomationProjectOption[] {
  const result: AutomationProjectOption[] = [];
  let conversationWorkspaceIncluded = false;

  for (const tab of workspaceTabs) {
    if (tab.availability === "unavailable-local-directory") continue;
    const isRemoteTab = Boolean(tab.remoteSessionId && (tab.remoteTarget || tab.workspaceIdentity));
    if (isRemoteTab && !config.includeRemoteWorkspaces) continue;

    if (tab.workspacePurpose === "conversation") {
      if (!config.includeConversationWorkspace || conversationWorkspaceIncluded) {
        continue;
      }
      // 历史设置可能残留多个 conversation backing path，但它们都表示同一个
      // “无项目会话”逻辑目标。保留 purpose 而不是依赖 default 文案识别，菜单才能复用
      // 会话侧「不在项目中工作」的固定文案与图标，同时仍只绑定一个 canonical cwd。
      conversationWorkspaceIncluded = true;
      result.push({
        workspacePath: tab.workspacePath,
        label: "default",
        workspacePurpose: "conversation",
      });
      continue;
    }

    result.push({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      remote: isRemoteTab || undefined,
      label: resolveWorkspaceTabDisplayName(tab, workspaceDisplayNameOverrides) || workspaceBasename(tab.workspacePath),
    });
  }

  return result;
}

/**
 * 自动化创建只读取当前窗口已经打开且仍可用的本地 workspace。
 * 定时任务可显式加入一个“无项目会话”逻辑目标；闲时任务保持仅真实项目。
 *
 * 候选只保留可用的本地 workspace tab，排除最近项目和远端 tab，
 * 避免把远端 identity 交给本地 host，或让闲时任务继承远端 workspace。
 * 两类任务共用入口过滤规则，保持一致的项目隔离语义。
 */
export function useAutomationProjectOptions(
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const tabs = useTabStore((state) => state.tabs);
  const workspaceDisplayNameOverrides = useWorkspaceDisplayNameOverrides();
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const localWorkspaceTabs = useLocalWorkspaceScopes({ workspaceTabs });
  const includeConversationWorkspace = config.includeConversationWorkspace === true;
  const includeRemoteWorkspaces = config.includeRemoteWorkspaces === true;
  // 远端 workspace 不进入 useLocalWorkspaceScopes（本地作用域查询会因缺少
  // remoteSessionId 落到本地服务），这里显式并回已连接的远端 tab。
  const candidateTabs = useMemo(
    () =>
      includeRemoteWorkspaces
        ? [
            ...localWorkspaceTabs,
            ...workspaceTabs.filter(
              (tab) =>
                Boolean(tab.remoteSessionId && (tab.remoteTarget || tab.workspaceIdentity)) &&
                !localWorkspaceTabs.includes(tab),
            ),
          ]
        : localWorkspaceTabs,
    [includeRemoteWorkspaces, localWorkspaceTabs, workspaceTabs],
  );

  return useMemo(
    () =>
      resolveAutomationProjectOptions(
        candidateTabs,
        {
          includeConversationWorkspace,
          includeRemoteWorkspaces,
        },
        workspaceDisplayNameOverrides,
      ),
    [candidateTabs, includeConversationWorkspace, includeRemoteWorkspaces, workspaceDisplayNameOverrides],
  );
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
