import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
}

export function resolveChromiumHardwareAccelerationSettingsFile(
  homePath: string = homedir(),
): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

/**
 * 启动早期读硬件加速开关的候选文件：数据根优先，旧的 HOME 位置兜底。
 * 设置文件跟随数据根后，只看 HOME 会读到另一个实例的设置。
 */
function resolveChromiumHardwareAccelerationSettingsCandidates(): string[] {
  const candidates: string[] = [];
  const explicitHome = process.env.ZCODE_DESKTOP_HOME_DIR?.trim();
  const explicitDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (explicitHome) {
    candidates.push(join(explicitHome, ".zcode", "v2", "setting.json"));
  } else if (explicitDataBaseDir) {
    candidates.push(join(explicitDataBaseDir, ".zcode", "v2", "setting.json"));
  } else {
    candidates.push(resolveChromiumHardwareAccelerationSettingsFile());
  }
  const legacy = resolveChromiumHardwareAccelerationSettingsFile();
  if (!candidates.includes(legacy)) {
    candidates.push(legacy);
  }
  return candidates;
}

export function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return true;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function readBootstrapChromiumHardwareAccelerationEnabledFromDisk(): boolean {
  for (const settingsFile of resolveChromiumHardwareAccelerationSettingsCandidates()) {
    if (!existsSync(settingsFile)) {
      continue;
    }
    try {
      const raw = readFileSync(settingsFile, "utf-8");
      return extractBootstrapChromiumHardwareAccelerationEnabled(JSON.parse(raw));
    } catch {
      // 损坏或半截 JSON：继续看下一个候选。
    }
  }
  return true;
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  const enabled =
    rawSettings === undefined
      ? readBootstrapChromiumHardwareAccelerationEnabledFromDisk()
      : extractBootstrapChromiumHardwareAccelerationEnabled(rawSettings);
  if (!enabled) {
    // Electron 只能在 app ready 前关闭 Chromium 硬件加速。
    // 因此设置页保存后必须在下一次 main 进程最早期读取并应用，不能等到 whenReady。
    app.disableHardwareAcceleration();
  }
  return enabled;
}
