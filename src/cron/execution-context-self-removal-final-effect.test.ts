import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../gateway/agent-runtime-approval-authority.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import type { CronStoredJob } from "./types.js";

const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../infra/agent-run-registry.js");
const { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } =
  await import("./active-jobs.js");
const { resolveAdmittedRunActiveAssertion } = await import("../agents/admitted-run-context.js");
const { createAdmittedGatewayToolCallerIdentity, withGatewayToolCallerIdentity } =
  await import("../agents/tools/gateway-caller-context.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const CFG: OpenClawConfig = {};

function storedJob(id: string): CronStoredJob {
  return {
    id,
    agentId: "main",
    name: id,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "work" },
    delivery: { mode: "none" },
    state: {},
    sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
    createdActor: { type: "human", source: "profile", id: "profile-requester" },
  } as CronStoredJob;
}

beforeEach(() => {
  setRuntimeConfigSnapshot(CFG);
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
});

/**
 * Runs a scheduled CLI run's self-scoped `automations remove` on its own job
 * against the real in-process Gateway dispatch and `cron.remove` handler, with a
 * store that holds the removal open until the test resumes it. `closeDuringRemove`
 * settles the run (as src/cron/isolated-agent/run.ts does) while the handler awaits.
 */
async function removeOwnJob(closeDuringRemove: boolean) {
  const jobs = new Map([
    ["job-1", storedJob("job-1")],
    ["sibling-job", storedJob("sibling-job")],
  ]);
  let resumeRemove = () => {};
  const removeHeld = new Promise<void>((resolve) => {
    resumeRemove = resolve;
  });
  let removeEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    removeEntered = resolve;
  });
  const context = createContext([
    ["cron.remove", "operator.admin", "cron", cronHandlers["cron.remove"]!],
  ]);
  Object.assign(context, {
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cron: {
      getDefaultAgentId: () => "main",
      readJob: async (id: string) => jobs.get(id),
      getJob: (id: string) => jobs.get(id),
      remove: async (id: string, options?: { commitGuard?: () => void }) => {
        removeEntered();
        if (closeDuringRemove) {
          await removeHeld;
        }
        // The store runs the commit guard at its lock, right before the effect.
        options?.commitGuard?.();
        return { ok: true, removed: jobs.delete(id) };
      },
    },
  });
  // The cron timer marks the job active and binds the admitted run to that
  // marker (src/cron/service/timer-job-runner.ts); self-removal checks both.
  const marker = markCronJobActive("job-1", { agentId: "main" });
  const occurrence = await admitScheduledOccurrence({
    cfg: CFG,
    job: jobs.get("job-1")!,
    agentId: "main",
    trigger: "cron",
  });
  const admission = prepareCronRunAdmission({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: "job-1",
    deliveryAttemptFence: null,
    resolveGatewayContext: () => context,
    scheduledExecution: occurrence.mint({
      cfg: CFG,
      agentId: "main",
      runId: "run-1",
      runSessionKey: RUN_KEY,
      toolsAllow: ["*"],
    }),
  });
  let claim: string | undefined;
  const invocation: { nextCheckEnabled: boolean; assertCurrent: () => void; closed?: boolean } = {
    nextCheckEnabled: false,
    assertCurrent: () => {},
  };
  // Settles the run the way the cron runner and timer do: close the invocation,
  // release the run context, close the admission and clear the active marker.
  const settle = () => {
    invocation.closed = true;
    releaseAgentRunContext("run-1", claim);
    admission.close();
    clearCronJobActive("job-1", marker);
  };
  try {
    const admitted = await admission.preparedRunAdmission.admit("embedded");
    bindCronJobAdmittedRun(marker, admitted, new AbortController().signal);
    invocation.assertCurrent = resolveAdmittedRunActiveAssertion(admitted) ?? (() => {});
    claim = claimAgentRunContext(
      "run-1",
      { sessionKey: RUN_KEY, cronRunsByJobId: new Map([["job-1", invocation]]) },
      { trackOwner: true, ownsContext: true },
    );
    const tools = (
      await resolveGatewayScopedTools({
        cfg: CFG,
        sessionKey: RUN_KEY,
        sessionId: "run-session",
        runId: "run-1",
        senderIsOwner: false,
        surface: "loopback",
        admittedRunContext: admitted,
        toolsAllow: ["*"],
      })
    ).tools;
    const automations = tools.find((tool) => tool.name === "automations");
    if (!automations) {
      throw new Error("the CLI run was not offered automations");
    }
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: RUN_KEY,
    });
    const call = withGatewayToolCallerIdentity(caller, () =>
      automations.execute("remove", { action: "remove", jobId: "job-1" }),
    ).then(
      (result) => ({ ok: true as const, details: result.details }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    if (closeDuringRemove) {
      await entered;
      settle();
      resumeRemove();
    }
    return { outcome: await call, remaining: [...jobs.keys()] };
  } finally {
    if (!invocation.closed) {
      settle();
    }
    occurrence.release();
  }
}

describe("CLI self-removal through the real Gateway cron handler", () => {
  it("removes the run's own job while the run is current", async () => {
    const { outcome, remaining } = await removeOwnJob(false);
    expect(outcome.ok).toBe(true);
    expect(remaining).toEqual(["sibling-job"]);
  });

  it("keeps the job when the run settles while the removal awaits the store", async () => {
    const { outcome, remaining } = await removeOwnJob(true);
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer active|exact live run/),
    });
    expect(remaining).toEqual(["job-1", "sibling-job"]);
  });
});
