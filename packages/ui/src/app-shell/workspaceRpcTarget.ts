import type { RemoteTarget } from "@zcode/shared";

interface AppWorkspaceRpcTarget {
  workspaceIdentity?: string;
  remoteSessionId?: string;
  // activeTarget 的来源（tabStore）已经是 RemoteTarget；这里不再放宽成 unknown，
  // 否则下游按类型消费 remoteTarget 时只能各自断言。
  remoteTarget?: RemoteTarget;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveAppWorkspaceRpcTarget({
  activeTarget,
  explicitWorkspaceIdentity,
  explicitRemoteSessionId,
}: {
  activeTarget: AppWorkspaceRpcTarget;
  explicitWorkspaceIdentity?: string;
  explicitRemoteSessionId?: string;
}): AppWorkspaceRpcTarget {
  return {
    workspaceIdentity:
      normalizeOptionalString(activeTarget.workspaceIdentity) ??
      normalizeOptionalString(explicitWorkspaceIdentity),
    remoteSessionId:
      normalizeOptionalString(activeTarget.remoteSessionId) ??
      normalizeOptionalString(explicitRemoteSessionId),
    remoteTarget: activeTarget.remoteTarget,
  };
}
