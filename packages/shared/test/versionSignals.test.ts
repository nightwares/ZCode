import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 版本信号契约（fork 维护）：
 *
 * fork 版本号（<upstream>-nightwares.N）不在 zcode.z.ai 官方发布版本表内：
 * 远控页对未知版本 404，client/configs 灰度与套餐/领取接口按版本判定能力
 * （三起线上事故：QR 404、灰度拒答、Start Plan 不可用）。因此：
 *
 * - official：所有发给官方端点的版本信号（app_version 参数、X-ZCode-App-Version
 *   头、clientVersion 字段、登录跳转 URL）必须使用 UPSTREAM_APP_VERSION，
 *   或在值入口处 normalizeUpstreamAppVersion()。经 option/env 传入的站点用
 *   viaOption 标注，并在 note 指明已归一的注入点。
 * - deploy：部署/更新/协议判定（server bundle 版本等值、mock-cdn 路径、
 *   semver 比较、DPAPI 绑定）保留完整 fork 版本——字符串不等式正是
 *   fork 触发重部署的机制。
 * - telemetry：遥测/反馈保留真实 fork 版本。
 * - local：本地缓存键、展示文案等保留完整版本。
 *
 * 新增版本信号必须在本测试登记分类；未登记或 official 站点裸用
 * ZCODE_VERSION 都会让本测试失败。改动分类前先读上面四行。
 */

type SignalClass = "official" | "deploy" | "telemetry" | "local" | "build";

interface IndexEntry {
  file: string;
  /** 用法行内必须出现的片段（匹配扫描到的行）。 */
  match: string;
  class: SignalClass;
  /** 值经 option/env 形参传入；注入点在别处已归一（见 note）。 */
  viaOption?: boolean;
  /**
   * 行内已不含任何扫描模式（完全归一后不再出现 ZCODE_VERSION 等字样）。
   * 此类条目仅作分类存档：断言源文件仍包含该片段。
   */
  documented?: boolean;
  note?: string;
}

const INDEX: IndexEntry[] = [
  // ---------- official：直接归一 ----------
  {
    file: "packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts",
    match: '"app_version", UPSTREAM_APP_VERSION',
    class: "official",
    note: "billing/preview 与套餐 client/configs",
  },
  {
    file: "packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts",
    match: '"X-ZCode-App-Version": UPSTREAM_APP_VERSION',
    class: "official",
    note: "billing/claim 版本头",
  },
  {
    file: "packages/services/src/model-provider/zaiStartPlanBilling.ts",
    match: '"app_version", UPSTREAM_APP_VERSION',
    class: "official",
    note: "billing/balance",
  },
  {
    file: "packages/services/src/oauth/providers/configUtils.ts",
    match: '"app_version", UPSTREAM_APP_VERSION',
    class: "official",
    note: "OAuth 登录跳转（官网 deep link 行为按版本判定）",
  },
  {
    file: "packages/desktop/src/main/forceUpdateGuard.ts",
    match: '"app_version", UPSTREAM_APP_VERSION',
    class: "official",
    note: "强更配置请求",
  },
  {
    file: "packages/desktop/src/main/index.ts",
    match: "normalizeUpstreamAppVersion(ZCODE_VERSION || app.getVersion())",
    class: "official",
    note: "clientConfigAppVersion：帮助配置/灰度/远控 QR 共用",
  },
  {
    file: "packages/web/src/communityUrl.ts",
    match: "buildHelpAppConfigUrl(endpoint, UPSTREAM_APP_VERSION)",
    class: "official",
    documented: true,
    note: "web 帮助配置",
  },
  // ---------- official：值经 option/env 注入 ----------
  {
    file: "packages/services/src/marketing-touch/marketingTouchService.ts",
    match: '"X-ZCode-App-Version": options.appVersion',
    class: "official",
    viaOption: true,
    note: "注入点 services/node.ts marketing appVersion: UPSTREAM_APP_VERSION",
  },
  {
    file: "packages/shared/src/zcode-source-headers.ts",
    match: '...(appVersion ? { "X-ZCode-App-Version": appVersion } : {})',
    class: "official",
    viaOption: true,
    note: "共享头组装点；official 调用方（services sourceHeaders 默认值、desktop main、CLI model-config/routing）均已归一，telemetryCore 传 raw 属遥测",
  },
  {
    file: "packages/shared/src/helpAppConfig.ts",
    match: '"app_version", version',
    class: "official",
    viaOption: true,
    note: "调用方 desktop main clientConfigAppVersion 与 web communityUrl 均已归一",
  },
  {
    file: "packages/shared/src/web-remote-control.ts",
    match: '"app_version", appVersion',
    class: "official",
    viaOption: true,
    note: "远控 URL 组装；desktop main 传 webRemoteControlAppVersion（归一）",
  },
  {
    file: "packages/shared/src/web-remote-control.ts",
    match: '["appVersion", "app_version"]',
    class: "official",
    viaOption: true,
    note: "远控中继 query 参数映射表",
  },
  {
    file: "packages/desktop/src/main/desktopContextPromptRollout.ts",
    match: '"app_version", options.appVersion',
    class: "official",
    viaOption: true,
    note: "注入点 desktop main electronClientConfigsFetcher appVersion（归一）",
  },
  {
    file: "packages/provider-node/src/zcode-builtin-download.ts",
    match: '"app_version", options.appVersion',
    class: "official",
    viaOption: true,
    note: "注入点 services/node.ts fetchRelease 与 cli process-provider-registry-runtime（均归一）",
  },
  {
    file: "packages/services/src/client-config/clientConfigService.ts",
    match: '"app_version", context.appVersion',
    class: "official",
    viaOption: true,
    note: "注入点 services/node.ts IClientConfigService（归一）与 desktop main",
  },
  {
    file: "apps/zcode-cli/packages/bootstrap/src/model-config.ts",
    match: '"X-ZCode-App-Version": appVersion',
    class: "official",
    viaOption: true,
    note: "resolveAppVersionForHeaders 已在入口 normalizeUpstreamAppVersion",
  },
  {
    file: "apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing-source-headers.ts",
    match: "env[ZCODE_APP_VERSION_ENV] ?? options.appVersion",
    class: "official",
    viaOption: true,
    note: "包一层 normalizeUpstreamAppVersion（相邻行）",
  },
  // ---------- deploy：完整 fork 版本 ----------
  { file: "packages/server/src/http.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/entry-stdio.ts", match: "process.stdout.write(ZCODE_VERSION", class: "deploy" },
  { file: "packages/server/src/entry-stdio.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/remoteAssetLiveIdentity.ts", match: '"releases", ZCODE_VERSION,', class: "deploy" },
  { file: "packages/server/src/remote/remoteAssetLiveIdentity.ts", match: "ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/remoteAssetLiveIdentity.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/handshake.ts", match: "version: ZCODE_VERSION,", class: "deploy", note: "fork 客户端/服务端互认" },
  { file: "packages/server/src/remote/deploy.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/deploy.ts", match: "appVersion: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/deploy.ts", match: '"local:", ZCODE_VERSION', class: "deploy" },
  { file: "packages/server/src/remote/deploy.ts", match: "if (version !== ZCODE_VERSION)", class: "deploy", note: "server bundle 等值判定——fork 触发重部署的机制" },
  { file: "packages/server/src/remote/deploy.ts", match: "expected=${ZCODE_VERSION}", class: "deploy" },
  { file: "packages/server/src/remote/deploy.ts", match: 'join(mockCdnDir, "releases", ZCODE_VERSION)', class: "deploy" },
  { file: "packages/server/src/remote/remoteAssetDeployDecision.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/server/src/remote/connect.ts", match: "envParts.push(`${ZCODE_APP_VERSION_ENV}", class: "deploy", note: "向远端转发桌面版本；远端头入口自行归一" },
  { file: "packages/zcode-server-cli/src/cli.ts", match: "version: ZCODE_VERSION }", class: "deploy" },
  { file: "packages/zcode-server-cli/src/cli.ts", match: "createStoppedServerStatus(ZCODE_VERSION)", class: "deploy" },
  { file: "packages/zcode-server-cli/src/cli.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/zcode-server-cli/src/server-core/core.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/zcode-server-cli/src/server-core/http.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/shared/src/source-server/compatibility.ts", match: ": ZCODE_VERSION;", class: "deploy", note: "兼容性下限回退值" },
  { file: "packages/shared/src/source-server/compatibility.ts", match: "productVersion = ZCODE_VERSION,", class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: "if (descriptor.version !== ZCODE_VERSION)", class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: "expected ${ZCODE_VERSION}", class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: "ZCODE_VERSION,", class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: '"source-server", ZCODE_VERSION', class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: '"releases", ZCODE_VERSION)', class: "deploy" },
  { file: "packages/desktop/src/host/sourceServerReleaseResolver.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/desktop/src/main/desktopRuntimeEnv.ts", match: '"releases", ZCODE_VERSION)', class: "deploy" },
  { file: "packages/desktop/src/main/desktopRuntimeEnv.ts", match: "version: ZCODE_VERSION,", class: "deploy" },
  { file: "packages/desktop/src/main/desktopRuntimeEnv.ts", match: '[ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,', class: "deploy", note: "子进程完整版本；CLI 头入口自行归一，遥测读原值" },
  { file: "packages/desktop/src/main/remoteCdn.ts", match: "options.version ?? ZCODE_VERSION", class: "deploy", note: "官方 CDN 无 fork 发布——fork 走 mock-cdn 路径" },
  { file: "packages/desktop/src/main/windowsChromeAppBoundKey.ts", match: "expectedAppVersion ?? ZCODE_VERSION", class: "deploy", note: "须与 DPAPI 绑定写入值一致" },
  { file: "packages/desktop/src/main/autoUpdater.ts", match: "devAutoUpdateVersionOverride ?? app.getVersion()", class: "deploy", note: "fork 构建 ZCODE_AUTO_UPDATE_ENABLED 未注入=禁用" },
  { file: "packages/desktop/src/main/autoUpdater.ts", match: "ZCODE_VERSION;", class: "deploy" },
  { file: "packages/desktop/src/main/autoUpdater.ts", match: "dev update enabled version=", class: "deploy" },
  // ---------- telemetry：真实 fork 版本 ----------
  { file: "packages/services/src/telemetry/telemetryCore.ts", match: "dependencies.appVersion ?? ZCODE_VERSION", class: "telemetry" },
  { file: "packages/services/src/feedback/feedbackLogArchive.ts", match: "`appVersion: ${ZCODE_VERSION}`", class: "telemetry" },
  { file: "packages/services/src/feedback/feedbackService.ts", match: "appVersion: ZCODE_VERSION,", class: "telemetry" },
  { file: "packages/services/src/feedback/feedbackHttpClient.ts", match: 'assignDefined(environment, "app_version", device.appVersion)', class: "telemetry" },
  { file: "packages/desktop/src/renderer/src/userActionTraceBootstrap.ts", match: 'serviceVersion: ZCODE_VERSION || "unknown"', class: "telemetry" },
  { file: "packages/desktop/src/main/appARMSBootstrap.ts", match: "version: ZCODE_VERSION,", class: "telemetry" },
  { file: "packages/desktop/src/main/appARMSBootstrap.ts", match: "arms] electron initialized", class: "telemetry" },
  { file: "packages/desktop/src/main/databaseStartupTelemetry.ts", match: "appVersion: ZCODE_VERSION,", class: "telemetry" },
  { file: "packages/desktop/src/shared/armsRumShared.ts", match: "version: ZCODE_VERSION,", class: "telemetry" },
  { file: "packages/desktop/src/main/index.ts", match: "version: ZCODE_VERSION || app.getVersion()", class: "telemetry", note: "localTtftExporter" },
  { file: "apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts", match: "env.ZCODE_APP_VERSION", class: "telemetry" },
  { file: "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts", match: "options.env?.ZCODE_APP_VERSION", class: "telemetry", note: "协议状态上报" },
  // ---------- local：缓存键/展示 ----------
  { file: "packages/zcode-server-cli/src/cli.ts", match: "stdout(io, json ? { product:", class: "local", note: "--version 输出" },
  { file: "packages/desktop/src/main/about.ts", match: "?? ZCODE_VERSION)", class: "local", note: "关于页展示" },
  { file: "packages/desktop/src/main/about.ts", match: "appVersion: app.getVersion()", class: "local" },
  { file: "packages/ui/src/remote-connection-flow/index.ts", match: "localVersion: ZCODE_VERSION,", class: "local", note: "连接 UI 对比展示" },
  { file: "apps/zcode-cli/packages/cli/src/provider-runtime-env.ts", match: "options.appVersion ?? ZCODE_VERSION", class: "local", note: "builtin 配置缓存路径按完整版本分桶" },
  { file: "packages/services/src/node.ts", match: "appVersion: ZCODE_VERSION,", class: "local", note: "zcodeBuiltinEnvironment 缓存键；同函数 fetchRelease 已归一" },
  { file: "packages/desktop/src/main/index.ts", match: "appVersion: ZCODE_VERSION,", class: "telemetry", note: "ARMS/stability 上下文" },
  // ---------- build：构建期 define 注入 ----------
  { file: "packages/desktop/tsup.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion)", class: "build", note: "主进程 define 注入完整版本" },
  { file: "packages/desktop/vite.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion)", class: "build" },
  { file: "packages/server/build-remote.ts", match: "__ZCODE_VERSION__: JSON.stringify(version)", class: "build" },
  { file: "packages/server/tsup.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(version)", class: "build" },
  { file: "packages/web/vite.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(", class: "build" },
  { file: "packages/web-share/vite.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(version)", class: "build" },
  { file: "packages/zcode-server-cli/tsup.config.ts", match: "__ZCODE_VERSION__: JSON.stringify(rootPackageJson.version)", class: "build" },
  { file: "apps/zcode-cli/packages/bootstrap/src/model-config.ts", match: "normalizeUpstreamAppVersion(env[ZCODE_APP_VERSION_ENV]", class: "official", note: "CLI 头版本入口归一" },
  // ---------- local：定义与参数透传 ----------
  { file: "packages/shared/src/env.ts", match: '= "ZCODE_APP_VERSION" as const;', class: "local", note: "环境变量键名定义" },
  { file: "packages/web/src/auth/oauthStateCodec.ts", match: 'new Set(["app_version", "sid"', class: "local", note: "OAuth 回跳参数透传白名单" },
  { file: "packages/web/src/web-remote-control/app/webRemoteControlEntry.ts", match: 'url.searchParams.get("app_version")', class: "local", note: "读取 QR 携带的版本（桌面侧已归一）" },
  { file: "packages/web/src/web-remote-control/app/webRemoteControlVersion.ts", match: 'url.searchParams.get("app_version") !== version', class: "official", viaOption: true, note: "传播 QR 提供的版本（已归一）" },
  { file: "packages/web/src/web-remote-control/app/webRemoteControlVersion.ts", match: 'url.searchParams.set("app_version", version)', class: "official", viaOption: true, note: "传播 QR 提供的版本（已归一）" },
  // ---------- telemetry：补充 ----------
  { file: "packages/shared/src/processResourceTelemetry.ts", match: '"app_version",', class: "telemetry" },
  { file: "apps/zcode-cli/packages/cli/src/prompt-command.ts", match: "productVersion: env.ZCODE_APP_VERSION", class: "telemetry" },
  { file: "apps/zcode-cli/packages/cli/src/tui-prompt-handler-runtime.ts", match: "productVersion: env.ZCODE_APP_VERSION", class: "telemetry" },
  { file: "apps/zcode-cli/packages/telemetry/src/bootstrap.ts", match: "normalizeVersion(options.productVersion ?? env.ZCODE_APP_VERSION)", class: "telemetry" },
];

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCAN_ROOTS = ["packages", "apps/zcode-cli/packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-release", "test", "tests", "__tests__", "e2e"]);
const EXEMPT_FILES = new Set([
  // 版本常量与归一 helper 的定义处。
  "packages/shared/src/version.ts",
]);
const PATTERNS = [
  "ZCODE_VERSION",
  "ZCODE_APP_VERSION",
  "app.getVersion()",
  "X-ZCode-App-Version",
  '"app_version"',
];

interface UsageLine {
  file: string;
  line: number;
  text: string;
}

/** 逐行去掉注释内容：跟踪块注释与字符串状态，避免误伤 URL 或模板串内的 //。 */
function stripCommentFromLine(line: string, state: { blockComment: boolean }): string {
  let out = "";
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (state.blockComment) {
      if (ch === "*" && next === "/") {
        state.blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      state.blockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** import/export-from 语句内的标识符不算用法。 */
function isImportOrReexportLine(strippedLine: string, state: { inImport: boolean; inExportFrom: boolean }): boolean {
  const t = strippedLine.trim();
  if (state.inImport) {
    if (/from\s+["']/.test(t)) state.inImport = false;
    return true;
  }
  if (state.inExportFrom) {
    // 具名 export 块（无 from）以 } 结束；再导出块以 } from 结束。两种都要闭合。
    if (/from\s+["']/.test(t) || /^}/.test(t)) state.inExportFrom = false;
    return true;
  }
  if (/^import\s/.test(t) && !/^import\s+type\s/.test(t)) {
    if (!/from\s+["']/.test(t)) state.inImport = true;
    return true;
  }
  if (/^export\s*\{/.test(t) && !/from\s+["']/.test(t)) {
    state.inExportFrom = true;
    return true;
  }
  return false;
}

function* walkTsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith(".")) yield* walkTsFiles(full);
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.includes(".test.")) continue;
    yield full;
  }
}

function scanUsageLines(): UsageLine[] {
  const usages: UsageLine[] = [];
  for (const root of SCAN_ROOTS) {
    for (const filePath of walkTsFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, filePath);
      if (EXEMPT_FILES.has(rel)) continue;
      const commentState = { blockComment: false };
      const importState = { inImport: false, inExportFrom: false };
      const lines = readFileSync(filePath, "utf8").split("\n");
      lines.forEach((raw, idx) => {
        const stripped = stripCommentFromLine(raw, commentState);
        if (isImportOrReexportLine(stripped, importState)) return;
        if (!PATTERNS.some((p) => stripped.includes(p))) return;
        usages.push({ file: rel, line: idx + 1, text: stripped.trim() });
      });
    }
  }
  return usages;
}

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

describe("版本信号索引（fork 维护契约）", () => {
  const usages = scanUsageLines();

  it("扫描覆盖到版本用法（防止扫描器悄悄失效）", () => {
    expect(usages.length).toBeGreaterThan(40);
  });

  it("每个版本用法行都已登记分类", () => {
    const uncovered: string[] = [];
    for (const usage of usages) {
      const covered = INDEX.some(
        (e) => e.file === usage.file && usage.text.includes(e.match),
      );
      if (!covered) {
        uncovered.push(`${usage.file}:${usage.line}: ${usage.text}`);
      }
    }
    expect(
      uncovered,
      [
        "存在未登记的版本信号用法——先分类（official/deploy/telemetry/local），",
        "再把它加进 versionSignals.test.ts 的 INDEX：",
        ...uncovered,
      ].join("\n"),
    ).toEqual([]);
  });

  it("INDEX 无过期条目（源码行已删改时同步清理）", () => {
    const stale: string[] = [];
    for (const entry of INDEX) {
      if (entry.documented) {
        // 行内已无扫描模式（完全归一）：只断言片段仍在源文件里，作为分类存档。
        let text = "";
        try {
          text = readFileSync(join(REPO_ROOT, entry.file), "utf8");
        } catch {
          // 文件缺失视为过期
        }
        if (!text.includes(entry.match)) stale.push(`${entry.file} :: ${entry.match}`);
        continue;
      }
      const matched = usages.some((u) => u.file === entry.file && u.text.includes(entry.match));
      if (!matched) stale.push(`${entry.file} :: ${entry.match}`);
    }
    expect(
      stale,
      ["INDEX 条目在源码里找不到对应行，请清理：", ...stale].join("\n"),
    ).toEqual([]);
  });

  it("official 站点禁止裸用完整版本", () => {
    const offenders: string[] = [];
    for (const entry of INDEX.filter((e) => e.class === "official")) {
      for (const usage of usages) {
        if (usage.file !== entry.file || !usage.text.includes(entry.match)) continue;
        const normalized =
          usage.text.includes("UPSTREAM_APP_VERSION") ||
          usage.text.includes("normalizeUpstreamAppVersion");
        if (!normalized && !entry.viaOption) {
          offenders.push(
            `${usage.file}:${usage.line}: official 站点必须使用 UPSTREAM_APP_VERSION（或 viaOption 标注注入点）: ${usage.text}`,
          );
        }
      }
    }
    expect(offenders.join("\n")).toEqual("");
  });

  it("UPSTREAM_APP_VERSION 常量存在且等于基线", async () => {
    const { UPSTREAM_APP_VERSION, ZCODE_VERSION, normalizeUpstreamAppVersion } = await import(
      "#src/version.js"
    );
    expect(UPSTREAM_APP_VERSION).toBe(normalizeUpstreamAppVersion(ZCODE_VERSION));
  });
});
