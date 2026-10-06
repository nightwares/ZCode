
import type { RemoteTarget, RemoteTargetSnapshot } from "@zcode/shared";
import { getPathLeaf, isFileSystemRootPath } from "@/lib/path.js";
import { formatRemoteWorkspaceHeaderHostLabel } from "@/lib/remoteWorkspaceHistory.js";

type RemoteWorkspaceTarget = RemoteTarget | RemoteTargetSnapshot;

export interface WorkspaceDisplayNameParams {
  workspacePath: string;
  remoteTarget?: RemoteWorkspaceTarget | null;
  /** 本地文件系统根目录的展示名（i18n 文案）。 */
  rootLabel: string;
}

/**
 * workspace 展示名的统一出口。路径叶子（getPathLeaf）无法给文件系统根目录命名：
 * devcontainer 等场景 workspace 就是远端根目录 "/"，标题会退化成 "/"。此时
 * 远端 workspace 唯一可读的身份是主机标识（容器名 / SSH host / WSL 发行版），
 * 本地根目录则回落到 i18n 文案。
 */
export function getWorkspaceDisplayName({
  workspacePath,
  remoteTarget,
  rootLabel,
}: WorkspaceDisplayNameParams): string {
  if (isFileSystemRootPath(workspacePath)) {
    return remoteTarget ? formatRemoteWorkspaceHeaderHostLabel(remoteTarget) : rootLabel;
  }
  return getPathLeaf(workspacePath);
}

/**
 * workspace 显示名覆盖的持久化键。与 tabStore / task-realtime-core 的
 * workspaceKey 规则保持一致：优先 workspaceIdentity（远端同路径隔离），
 * 缺省回退 workspacePath。
 */
export function getWorkspaceDisplayNameKey({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
}): string {
  const identity = workspaceIdentity?.trim();
  return identity ? identity : workspacePath;
}

export interface ResolveWorkspaceDisplayNameParams {
  workspacePath: string;
  remoteTarget?: RemoteWorkspaceTarget | null;
  /** 本地文件系统根目录的展示名（i18n 文案）；次要展示面可省略，此时本地根目录沿用路径本身。 */
  rootLabel?: string;
  workspaceIdentity?: string | null;
  /** 用户设置的显示名覆盖（AppSettings.workspaceDisplayNameOverrides）。 */
  overrides?: Record<string, string> | null;
}

/**
 * rename 之后的统一出口：用户覆盖名优先，其次自动派生（getWorkspaceDisplayName）。
 * rootLabel 允许缺省，供拿不到 i18n 文案的次要展示面使用（此时本地根目录沿用 "/"）。
 */
export function resolveWorkspaceDisplayName({
  workspacePath,
  remoteTarget,
  rootLabel,
  workspaceIdentity,
  overrides,
}: ResolveWorkspaceDisplayNameParams): string {
  const key = getWorkspaceDisplayNameKey({ workspacePath, workspaceIdentity });
  const override = overrides?.[key]?.trim();
  if (override) {
    return override;
  }
  return getWorkspaceDisplayName({
    workspacePath,
    remoteTarget,
    rootLabel: rootLabel ?? workspacePath,
  });
}

/** 侧边栏 tab / task 归属等场景的最小输入形状。 */
export interface WorkspaceTabLike {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteTarget?: RemoteWorkspaceTarget | null;
}

/** resolveWorkspaceDisplayName 的 tab 形态便捷入口（override 优先 + 自动派生）。 */
export function resolveWorkspaceTabDisplayName(
  tab: WorkspaceTabLike,
  overrides?: Record<string, string> | null,
  rootLabel?: string,
): string {
  return resolveWorkspaceDisplayName({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteTarget: tab.remoteTarget,
    rootLabel,
    overrides,
  });
}