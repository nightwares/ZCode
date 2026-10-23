
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRepo } from "@zcode/services/node";
import { IZCodeTaskService } from "@zcode/services";
import { Emitter } from "@zcode/rpc";
import type { ZCodeAutomationCreateParams, ZCodeTaskTerminalOutcome } from "@zcode/shared";
import { createAutomationScheduler, SCHEDULER_MISFIRE_GRACE_MS } from "../src/server-core/automationScheduler.js";

const MINUTE = 60_000;

function makeParams(overrides: Partial<ZCodeAutomationCreateParams> = {}): ZCodeAutomationCreateParams {
  return {
    title: "daily",
    cronExpr: "0 9 * * *",
    prompt: "do the thing",
    workspacePath: "/ws",
    recurring: true,
    ...overrides,
  };
}

/** Minimal IZCodeTaskService stub: records prompts, exposes the terminal emitter. */
function createTaskServiceStub() {
  const terminal = new Emitter<ZCodeTaskTerminalOutcome>();
  const sendPrompt = vi.fn(async () => undefined);
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const resumeTask = vi.fn(async () => undefined);
  const service = {
    createTask,
    resumeTask,
    sendPrompt,
    onDynamicTaskTerminalOutcome: () => terminal.event,
    setTaskUnread: vi.fn(async () => undefined),
  };
  const services = {
    getOptional: (descriptor: { channelName: string }) =>
      descriptor.channelName === IZCodeTaskService.channelName ? service : undefined,
  };
  return { services, terminal, sendPrompt, createTask, resumeTask };
}

describe("standalone automation scheduler", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: AutomationRepo;
  let clock: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-server-scheduler-"));
    dbPath = join(tempDir, "tasks-index.sqlite");
    repo = new AutomationRepo(dbPath);
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function seedDueAutomation(cronExpr = "0 9 * * *") {
    // 直接落 repo：AutomationService.create 的首次 nextRunAt 用真实时钟计算，
    // 无法注入测试时钟；调度测试需要精确的 due 时刻。
    return await repo.create(makeParams({ cronExpr }), {
      nextRunAt: clock - MINUTE,
    });
  }

  it("dispatches a due automation, advances next_run_at and records a schedule run", async () => {
    const automation = await seedDueAutomation();
    const stub = createTaskServiceStub();
    const scheduler = createAutomationScheduler({
      services: stub.services as never,
      repo,
      now: () => clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await scheduler.tick();

    expect(stub.sendPrompt).toHaveBeenCalledTimes(1);
    const after = await repo.get(automation.automationId);
    expect(after?.dispatchStatus).toBe("dispatched");
    expect(after?.runCount).toBe(1);
    expect(after?.nextRunAt).toBeGreaterThan(clock);
    const runs = await repo.listRuns(automation.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule" });
    expect(runs[0]?.outcome ?? null).toBeNull();
  });

  it("skips a window missed beyond the misfire grace and reschedules", async () => {
    const automation = await seedDueAutomation();
    const stub = createTaskServiceStub();
    const scheduler = createAutomationScheduler({
      services: stub.services as never,
      repo,
      now: () => clock + SCHEDULER_MISFIRE_GRACE_MS * 2,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await scheduler.tick();

    expect(stub.sendPrompt).not.toHaveBeenCalled();
    const runs = await repo.listRuns(automation.automationId);
    expect(runs[0]?.dispatchStatus).toBe("skipped");
    const after = await repo.get(automation.automationId);
    expect(after?.nextRunAt).toBeGreaterThan(clock);
  });

  it("releases the claim and schedules a retry when dispatch fails", async () => {
    const automation = await seedDueAutomation();
    const stub = createTaskServiceStub();
    stub.sendPrompt.mockRejectedValueOnce(new Error("boom"));
    const scheduler = createAutomationScheduler({
      services: stub.services as never,
      repo,
      now: () => clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await scheduler.tick();

    const after = await repo.get(automation.automationId);
    expect(after?.dispatchStatus).toBe("failed_to_dispatch");
    expect(after?.retryAt).not.toBeNull();
    expect(after?.dispatchAttempts).toBe(1);
    const runs = await repo.listRuns(automation.automationId);
    expect(runs[0]).toMatchObject({ dispatchStatus: "failed_to_dispatch" });
  });

  it("settles the run outcome when the task reports a terminal result", async () => {
    const automation = await seedDueAutomation();
    const stub = createTaskServiceStub();
    const scheduler = createAutomationScheduler({
      services: stub.services as never,
      repo,
      now: () => clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await scheduler.tick();
    const runsBefore = await repo.listRuns(automation.automationId);
    const runId = runsBefore[0]!.runId;
    stub.terminal.fire({
      taskId: "task-1",
      inputId: runId,
      outcome: "succeeded",
    });
    await vi.waitFor(async () => {
      const runs = await repo.listRuns(automation.automationId);
      expect(runs[0]?.outcome).toBe("succeeded");
    });
  });

  it("start() polls immediately and dispose() stops further ticks", async () => {
    await seedDueAutomation();
    const stub = createTaskServiceStub();
    const scheduler = createAutomationScheduler({
      services: stub.services as never,
      repo,
      pollIntervalMs: 1_000,
      now: () => clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    scheduler.start();
    await vi.waitFor(() => expect(stub.sendPrompt).toHaveBeenCalledTimes(1));
    await scheduler.dispose();
    const callsAfterDispose = stub.sendPrompt.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(stub.sendPrompt.mock.calls.length).toBe(callsAfterDispose);
  });
});
