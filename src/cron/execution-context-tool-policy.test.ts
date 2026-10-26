import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { useWidgetHarness } from "../canvas/widget-tool.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronStoredJob } from "./types.js";

// Records every automations Gateway RPC; cron.list answers with the run's job and
// a sibling, so a self-scoped list proves the sibling is filtered out.
const gatewayDispatches = vi.hoisted((): string[] => []);
vi.mock("../agents/tools/cron-tool-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/tools/cron-tool-gateway.js")>()),
  createCronToolGatewayCaller: () => async (method: string) => {
    gatewayDispatches.push(method);
    if (method !== "cron.list") {
      throw new Error(`unexpected Gateway call ${method}`);
    }
    const jobs = [{ id: "job-1" }, { id: "sibling-job" }];
    return {
      jobs,
      total: jobs.length,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
      snapshotRevision: "rev",
    };
  },
}));

const { createOpenClawCodingToolsInternalAsync } = await import("../agents/agent-tools.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { resolveScheduledSenderBit } = await import("./execution-context-registry.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const PROFILE = { type: "human", source: "profile", id: "profile-requester" } as const;
const CFG: OpenClawConfig = {};
const SCOPE_ERROR = "Automations tool is restricted to the current automation.";

function job(overrides: Partial<CronStoredJob>): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Tool policy",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "work" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

const linked = { sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } };

/** One stored job per placement and owner kind, with the session its run uses. */
const RUNS = [
  {
    name: "owner child (self-and-parent-wake scope)",
    job: job({ ...linked, createdActor: PROFILE }),
    runKey: RUN_KEY,
    placement: "child",
  },
  {
    name: "non-owner child (no recorded requester)",
    job: job({
      ...linked,
      scheduledToolPolicy: {
        mode: "account",
        ownerSessionKey: PARENT_KEY,
        ownerAccountId: "default",
      },
    } as Partial<CronStoredJob>),
    runKey: RUN_KEY,
    placement: "child",
  },
  {
    name: "detached operator job",
    job: job({ scheduledToolPolicy: { mode: "trusted" } } as Partial<CronStoredJob>),
    runKey: RUN_KEY,
    placement: "detached",
  },
  {
    name: "session: job",
    job: job({ sessionTarget: `session:${PARENT_KEY}` }),
    runKey: PARENT_KEY,
    placement: "in-session",
  },
] as const;

useWidgetHarness();

beforeEach(() => {
  setRuntimeConfigSnapshot(CFG);
  gatewayDispatches.length = 0;
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
});

const settles: (() => void)[] = [];
afterEach(() => {
  for (const settle of settles.splice(0)) {
    settle();
  }
});

// Admits an occurrence and its run the way the cron executor does.
async function admitRun(stored: CronStoredJob, runKey: string, toolsAllow: string[]) {
  const occurrence = await admitScheduledOccurrence({
    cfg: CFG,
    job: stored,
    agentId: "main",
    trigger: "cron",
  });
  const scheduledExecution = occurrence.mint({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    runSessionKey: runKey,
    toolsAllow,
  });
  const admission = prepareCronRunAdmission({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    sessionKey: runKey,
    jobId: stored.id,
    deliveryAttemptFence: null,
    scheduledExecution,
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const result = scheduledExecution.result;
  if (result.status !== "ready") {
    throw new Error(`expected a ready context, got ${result.status}`);
  }
  settles.push(() => {
    admission.close();
    occurrence.release();
  });
  return {
    admitted,
    runKey,
    toolsAllow,
    senderIsOwner: resolveScheduledSenderBit(result)?.senderIsOwner,
  };
}

type Run = Awaited<ReturnType<typeof admitRun>>;

async function embeddedTools(run: Run) {
  return await createOpenClawCodingToolsInternalAsync({
    config: CFG,
    agentId: "main",
    sessionKey: run.runKey,
    sessionId: "run-session",
    runId: "run-1",
    trigger: "cron",
    jobId: "job-1",
    operationalRunInstance: run.admitted.operationalRunInstance,
    ...(run.senderIsOwner !== undefined ? { senderIsOwner: run.senderIsOwner } : {}),
    runtimeToolAllowlist: run.toolsAllow,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
}

// The CLI grant coerces an absent bit to `false`; the loopback takes the run's
// bit from its context.
async function cliTools(run: Run) {
  const scoped = await resolveGatewayScopedTools({
    cfg: CFG,
    sessionKey: run.runKey,
    sessionId: "run-session",
    runId: "run-1",
    senderIsOwner: false,
    surface: "loopback",
    admittedRunContext: run.admitted,
    toolsAllow: run.toolsAllow,
  });
  return scoped.tools;
}

function readActionEnum(tool: AnyAgentTool): string[] {
  const action = (tool.parameters as { properties?: { action?: { enum?: unknown } } } | undefined)
    ?.properties?.action;
  return Array.isArray(action?.enum) ? (action.enum as string[]) : [];
}

async function callError(tool: AnyAgentTool, params: Record<string, unknown>) {
  try {
    await tool.execute("probe", params, undefined, undefined);
    return undefined;
  } catch (error) {
    return String(error);
  }
}

describe("scheduled automations scope", () => {
  describe.each(RUNS)("$name", (entry) => {
    it.each(["embedded", "cli"] as const)("%s run acts only on its own job", async (runtime) => {
      const run = await admitRun(entry.job, entry.runKey, ["*"]);
      const tools = runtime === "embedded" ? await embeddedTools(run) : await cliTools(run);
      const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
      expect(automations, "automations tool offered").toBeDefined();
      const actions = readActionEnum(automations!);
      expect(actions).toEqual(expect.arrayContaining(["status", "list", "get", "remove", "runs"]));
      // No creation, edits, forced runs or wake: the parent wake action is not offered yet.
      for (const action of ["add", "update", "run", "wake", "bind"]) {
        expect(actions).not.toContain(action);
      }
      for (const action of ["get", "remove", "runs"]) {
        expect(await callError(automations!, { action, jobId: "sibling-job" })).toContain(
          SCOPE_ERROR,
        );
      }
      expect(gatewayDispatches).toEqual([]);
      const listed = await automations!.execute("list", { action: "list" }, undefined, undefined);
      const jobs = (listed.details as { jobs?: { id: string }[] }).jobs ?? [];
      expect(jobs.map((listedJob) => listedJob.id)).toEqual(["job-1"]);
      expect(gatewayDispatches).toEqual(["cron.list"]);
    });

    it.each(["embedded", "cli"] as const)("%s run gets no sessions_yield", async (runtime) => {
      const run = await admitRun(entry.job, entry.runKey, ["*"]);
      const tools = runtime === "embedded" ? await embeddedTools(run) : await cliTools(run);
      expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
    });
  });

  it("a run whose tool cap excludes automations cannot call it on either runtime", async () => {
    const run = await admitRun(job({ ...linked, createdActor: PROFILE }), RUN_KEY, [
      "sessions_list",
    ]);
    for (const tools of [await embeddedTools(run), await cliTools(run)]) {
      const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
      // A denied owner-only tool may stay listed, but answers with a gated refusal.
      if (automations) {
        const result = await automations.execute("probe", { action: "status" });
        expect((result.details as { gated?: boolean } | undefined)?.gated).toBe(true);
      }
    }
    expect(gatewayDispatches).toEqual([]);
  });

  it("control: a session turn without a scheduled context keeps sessions_yield", async () => {
    const tools = await createOpenClawCodingToolsInternalAsync({
      config: CFG,
      agentId: "main",
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      runId: "turn-1",
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    expect(tools.map((tool) => tool.name)).toContain("sessions_yield");
  });
});
