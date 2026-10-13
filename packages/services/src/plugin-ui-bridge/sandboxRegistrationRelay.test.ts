import { describe, expect, it, vi } from "vitest";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginSandboxRegistrationRelay } from "./sandboxRegistrationRelay.js";

const input: PluginSandboxRegisterInput = {
  instance: {
    runtimeId: "agent",
    generation: 1,
    token: "one",
    appIdentity: "a".repeat(64),
  },
  ownerWebContentsId: 7,
  sessionId: "s",
  pluginId: "p",
  serverName: "server",
  scopeId: "tool:call",
  html: "<html></html>",
};

const handle: PluginSandboxHandle = {
  instance: input.instance,
  sandboxId: "sandbox-1",
  initId: 1,
  shellUrl: "zcode-sandbox://shell-a/instance/sandbox-1/",
  partition: "persist|p",
};

describe("plugin sandbox registration relay", () => {
  it("settles register via respond with the host handle", async () => {
    const relay = createPluginSandboxRegistrationRelay();
    const pending = relay.register(input);
    let received: { requestId: string; input: PluginSandboxRegisterInput } | undefined;
    relay.onRequest((request) => {
      received = request;
    });
    // onRequest 重放仍在等待的请求：晚到的订阅方不能漏掉首个登记。
    expect(received?.input).toEqual(input);
    relay.respond({ requestId: received!.requestId, ok: true, ...handle });
    await expect(pending).resolves.toEqual(handle);
  });

  it("rejects register when the host responds with an error", async () => {
    const relay = createPluginSandboxRegistrationRelay();
    const pending = relay.register(input);
    relay.onRequest((request) => {
      relay.respond({ requestId: request.requestId, ok: false, error: "denied" });
    });
    await expect(pending).rejects.toThrow("denied");
  });

  it("times out waiting registrations", async () => {
    vi.useFakeTimers();
    try {
      const relay = createPluginSandboxRegistrationRelay({ timeoutMs: 50 });
      const pending = relay.register(input);
      const assertion = expect(pending).rejects.toThrow(/timed out after 50ms/);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on dispose and ignores late responds", async () => {
    const relay = createPluginSandboxRegistrationRelay();
    const pending = relay.register(input);
    let requestId: string | undefined;
    relay.onRequest((request) => {
      requestId = request.requestId;
    });
    relay.dispose();
    await expect(pending).rejects.toThrow("relay closed");
    // dispose 后的迟到应答不允许二次结算，也不抛错中断调用方。
    expect(() =>
      relay.respond({ requestId: requestId!, ok: true, ...handle }),
    ).not.toThrow();
  });

  it("ignores responds for unknown or duplicate request ids", () => {
    const relay = createPluginSandboxRegistrationRelay();
    const pending = relay.register(input);
    let requestId = "";
    relay.onRequest((request) => {
      requestId = request.requestId;
    });
    // 未知 requestId：静默忽略。
    relay.respond({ requestId: "missing", ok: false, error: "x" });
    relay.respond({ requestId, ok: true, ...handle });
    // 重复应答同一 requestId：第二次必须被忽略，Promise 只结算一次。
    relay.respond({ requestId, ok: false, error: "late" });
    return expect(pending).resolves.toEqual(handle);
  });

  it("rejects incomplete handles instead of forwarding them", async () => {
    const relay = createPluginSandboxRegistrationRelay();
    const pending = relay.register(input);
    relay.onRequest((request) => {
      relay.respond({
        requestId: request.requestId,
        ok: true,
        ...handle,
        shellUrl: "",
      });
    });
    await expect(pending).rejects.toThrow("invalid handle");
  });
});
