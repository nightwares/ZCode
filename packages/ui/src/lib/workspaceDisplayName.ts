
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