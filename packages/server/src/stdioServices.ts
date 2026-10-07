import { createLocalServices, type ZCodeAgentCommandResolver } from "@zcode/services/node";
import {
  parseServiceAuthorityMode,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import { createManualAutomationDispatcher } from "./remote/manualAutomationDispatcher.js";

interface CreateStdioServicesOptions {
  env?: Record<string, string | undefined>;
  zcodeBuiltinProviderConfigFilePath: string;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
}

interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
}

function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ZCODE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
  };
}

export function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // 远端 server 里 "立即运行" 此前必然失败：zcodeAgentService 在认领 manual run
  // 之前就因缺少 onAutomationManualRunRequested 抛错。dispatcher 需要引用
  // 服务集合自身，而集合构造又要求先提供 dispatcher —— 用可变引用打破循环：
  // 构造时注入转发闭包，集合就绪后立刻回填真实实现。
  let dispatchManualRun: ReturnType<typeof createManualAutomationDispatcher> | null = null;
  // 远程 Desktop 的呈现能力必须从 stdio 入口收到的 authority mode 进入 Services 推导链。
  // 测试注入 resolver 只用于在 spawn 前观察最终命令，不改变生产默认 resolver。
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: authorityModeParseResult.mode,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    remoteAgentNetwork,
    onAutomationManualRunRequested: (params) => {
      if (!dispatchManualRun) {
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      return dispatchManualRun(params);
    },
  });
  dispatchManualRun = createManualAutomationDispatcher(services);

  return {
    authorityModeParseResult,
    services,
  };
}
