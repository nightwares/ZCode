import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "@zcode/services/node";

export function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

/**
 * 启动早期读取 dataBaseDir 的候选文件：数据根优先，旧的 HOME 位置兜底。
 *
 * 设置文件现在跟随数据根（与凭据、项目库同源），而 dataBaseDir 本身要等读完设置
 * 才知道——所以这里两个位置都要看，否则自定义数据根的实例永远读不到自己的设置。
 */
function resolveBootstrapSettingsCandidates(): string[] {
  const candidates: string[] = [];
  const explicitHome = process.env.ZCODE_DESKTOP_HOME_DIR?.trim();
  const explicitDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (explicitHome) {
    candidates.push(join(explicitHome, ".zcode", "v2", "setting.json"));
  } else if (explicitDataBaseDir) {
    candidates.push(join(explicitDataBaseDir, ".zcode", "v2", "setting.json"));
  } else {
    candidates.push(resolveBootstrapSettingsFile());
  }
  // 旧 HOME 位置兜底：升级前写的设置还在那里。
  const legacy = resolveBootstrapSettingsFile();
  if (!candidates.includes(legacy)) {
    candidates.push(legacy);
  }
  return candidates;
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(): string | null {
  for (const settingsFile of resolveBootstrapSettingsCandidates()) {
    if (!existsSync(settingsFile)) {
      continue;
    }
    try {
      const raw = readFileSync(settingsFile, "utf-8");
      const dataBaseDir = extractBootstrapDataBaseDir(JSON.parse(raw));
      if (dataBaseDir) {
        return dataBaseDir;
      }
    } catch {
      // 损坏或半截 JSON：继续看下一个候选，不阻断启动。
    }
  }
  return null;
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
