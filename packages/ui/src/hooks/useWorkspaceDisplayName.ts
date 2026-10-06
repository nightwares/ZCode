import { useCallback } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { getWorkspaceDisplayNameKey } from "@/lib/workspaceDisplayName.js";

const EMPTY_OVERRIDES: Record<string, string> = {};

/** 读取 workspace 显示名覆盖表（AppSettings.workspaceDisplayNameOverrides）。 */
export function useWorkspaceDisplayNameOverrides(): Record<string, string> {
  const { settings } = useSettings();
  return settings?.workspaceDisplayNameOverrides ?? EMPTY_OVERRIDES;
}

/**
 * workspace rename 的读取 + 写入出口。写入走 AppSettings（跨窗口同步、随设置持久化），
 * 传 null/空串删除覆盖，恢复自动派生名。
 */
export function useWorkspaceRename() {
  const { settings, update } = useSettings();

  const setDisplayName = useCallback(
    async (source: { workspacePath: string; workspaceIdentity?: string | null }, name: string | null) => {
      const key = getWorkspaceDisplayNameKey(source);
      const next: Record<string, string> = {
        ...(settings?.workspaceDisplayNameOverrides ?? {}),
      };
      const trimmed = name?.trim();
      if (trimmed) {
        next[key] = trimmed;
      } else {
        delete next[key];
      }
      await update({ workspaceDisplayNameOverrides: next });
    },
    [settings, update],
  );

  return {
    overrides: settings?.workspaceDisplayNameOverrides ?? EMPTY_OVERRIDES,
    setDisplayName,
  };
}
