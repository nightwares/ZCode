import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import type {
  PluginSandboxHandle,
  PluginSandboxRegisterInput,
  PluginSandboxRegisterResultPayload,
} from "@zcode/shared/mcp-apps";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { PluginSandboxRegisterRelayRequest } from "./contract.js";

/** 登记是本地 Electron 工作；30s 只兜 transport 异常，不承载用户可见等待。 */
const PLUGIN_SANDBOX_REGISTER_RELAY_TIMEOUT_MS = 30_000;

export interface PluginSandboxRegistrationRelay {
  /** prepareSandbox 走这里：登记请求发给订阅方（desktop Host），等待 respond 结算。 */
  register(input: PluginSandboxRegisterInput): Promise<PluginSandboxHandle>;
  /** desktop Host 的应答入口；未知 / 重复 requestId 只记日志。 */
  respond(params: PluginSandboxRegisterResultPayload): void;
  /** 订阅登记请求；订阅建立时重放仍在等待的请求，避免晚到的订阅方漏掉首个请求。 */
  onRequest(listener: (request: PluginSandboxRegisterRelayRequest) => void): { dispose(): void };
  /** 断连即失败：未决登记全部拒绝，不允许新登记。 */
  dispose(): void;
}

interface PendingRegistration {
  input: PluginSandboxRegisterInput;
  timeout: ReturnType<typeof setTimeout>;
  resolve(handle: PluginSandboxHandle): void;
  reject(error: Error): void;
}

/**
 * stdio 远端 runtime 的沙箱登记中继状态（仿 zcodeAgentService 的 browser-use 中继）：
 * 容器内没有 Electron main，register 把请求经 IPluginUiBridgeService 的动态事件转发给
 * desktop Host，Host 用 respondPluginSandboxRegister 原路回传句柄。
 * logger 必须在工厂里创建——本模块经 services 入口会进 renderer bundle，
 * 顶层 createServiceLogger 会在 import 时读 process.pid。
 */
export function createPluginSandboxRegistrationRelay(deps: {
  timeoutMs?: number;
  createRequestId?: () => string;
} = {}): PluginSandboxRegistrationRelay {
  const log = createServiceLogger("plugin-ui-bridge");
  const timeoutMs = deps.timeoutMs ?? PLUGIN_SANDBOX_REGISTER_RELAY_TIMEOUT_MS;
  const createRequestId = deps.createRequestId ?? randomUUID;
  const pending = new Map<string, PendingRegistration>();
  const requestEmitter = new Emitter<PluginSandboxRegisterRelayRequest>();
  let disposed = false;

  const takePending = (requestId: string): PendingRegistration | undefined => {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    return entry;
  };

  const settleFailure = (entry: PendingRegistration, message: string): void => {
    entry.reject(new Error(message));
  };

  return {
    register(input) {
      if (disposed) {
        return Promise.reject(new Error("Plugin sandbox registration relay closed"));
      }
      const requestId = createRequestId();
      return new Promise<PluginSandboxHandle>((resolve, reject) => {
        const entry: PendingRegistration = {
          input,
          timeout: setTimeout(() => {
            const expired = takePending(requestId);
            if (!expired) return;
            log.warn(undefined, "插件 UI 沙箱登记等待 Host 响应超时", {
              requestId,
              timeoutMs,
            });
            settleFailure(
              expired,
              `plugin sandbox registration timed out after ${timeoutMs}ms`,
            );
          }, timeoutMs),
          resolve,
          reject,
        };
        pending.set(requestId, entry);
        requestEmitter.fire({ requestId, input });
      });
    },
    respond(params) {
      const entry = takePending(params.requestId);
      if (!entry) {
        // 迟到应答 / 重复应答不能中断服务，也不允许二次结算。
        log.warn(undefined, "插件 UI 沙箱登记响应找不到 pending 请求", {
          requestId: params.requestId,
        });
        return;
      }
      if (!params.ok) {
        settleFailure(entry, params.error);
        return;
      }
      // 与 main 侧登记结果同构的句柄校验：缺字段按中继失败结算，不把残缺句柄透传给 renderer。
      if (
        !params.instance ||
        !params.sandboxId ||
        params.initId === undefined ||
        !params.shellUrl ||
        !params.partition
      ) {
        log.warn(undefined, "Host 返回的插件 UI 沙箱句柄不完整", {
          requestId: params.requestId,
        });
        settleFailure(entry, "plugin sandbox registration returned an invalid handle");
        return;
      }
      entry.resolve({
        instance: params.instance,
        sandboxId: params.sandboxId,
        initId: params.initId,
        shellUrl: params.shellUrl,
        partition: params.partition,
        ...(params.resourceMeta ? { resourceMeta: params.resourceMeta } : {}),
      });
    },
    onRequest(listener) {
      const disposable = requestEmitter.event(listener);
      for (const request of pending.entries()) {
        listener({ requestId: request[0], input: request[1].input });
      }
      return disposable;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        settleFailure(entry, "Plugin sandbox registration relay closed");
      }
      pending.clear();
      requestEmitter.dispose();
    },
  };
}
