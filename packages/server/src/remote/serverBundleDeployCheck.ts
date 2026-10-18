import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";

const REQUIRED_SERVER_BUNDLE_MARKERS = [
  "skill-sync",
  "mcp-sync",
  "plugin-sync",
  "__zcode_rpc_nested_uint8array_v1",
  "exportMarketplaceSourceArchive",
  "importMarketplaceSourceArchive",
  // 旧 nightwares server 缺远端中继：browser-use（respondBrowserControl）与 MCP Apps
  // （onDynamicPluginSandboxRegisterRequest）的请求会静默拿不到执行器（browserList 空、
  // 沙箱 unavailable）。旧 bundle 必须被检出并重部署，而不是带病通过。
  "respondBrowserControl",
  "onDynamicPluginSandboxRegisterRequest",
];

export type ServerBundleDeployDecision =
  | { shouldDeploy: false }
  | { shouldDeploy: true; reason: string };

export async function checkServerBundleRequiredMarkers(
  backend: IRemoteBackend,
  nodePath: string,
  serverPath: string,
): Promise<ServerBundleDeployDecision> {
  const script = `
const fs = require("fs");
const content = fs.readFileSync(process.argv[1], "utf8");
const missing = ${JSON.stringify(REQUIRED_SERVER_BUNDLE_MARKERS)}.filter((marker) => !content.includes(marker));
if (missing.length > 0) {
  console.error("missing required server bundle markers: " + missing.join(","));
  process.exit(2);
}
`;
  const stream = await backend.exec(
    `${quotePosixPathArg(nodePath)} -e ${quotePosixShellArg(script)} ${quotePosixPathArg(serverPath)}`,
  );
  try {
    await waitForDeployCheckClose(stream);
    return { shouldDeploy: false };
  } catch (error) {
    // 开发态远端 server 可能版本号相同但 bundle 内容仍是旧包，旧包没有
    // skill/plugin sync channel，renderer 侧会表现为 “Channel name 'skill-sync' timed out”。
    // 这里用远端已部署 bundle 的能力标记做精确探测，只在缺少必要 channel 时刷新主 server。
    return {
      shouldDeploy: true,
      reason: `remote server bundle missing required markers: ${String(error)}`,
    };
  }
}

function waitForDeployCheckClose(stream: StdioStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrText = "";
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length >= 2048) {
        return;
      }
      stderrText += chunk.toString();
    });
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderrText.trim() || `remote deploy check exited with code ${code}`));
    });
  });
}
