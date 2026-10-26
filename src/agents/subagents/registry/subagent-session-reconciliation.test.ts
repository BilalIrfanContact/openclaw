import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.js";
import { observeMainThreadReads } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  resolveStoredSubagentCapabilities as readCapabilities,
  resolvePersistedSubagentToolPolicyEnvelope as readPolicy,
} from "../spawn/subagent-capabilities.js";
import { getSubagentDepthFromSessionStoreInWorker as readDepth } from "../spawn/subagent-depth.js";
import { withPreparedSessionCapabilityRead } from "../spawn/subagent-session-store.js";
import {
  loadSubagentSessionEntry as loadEntry,
  resolveSubagentSessionCompletion as readCompletion,
  resolveSubagentSessionStartedAt as readStartedAt,
} from "./subagent-session-reconciliation.js";

const terminalSession: SessionEntry = {
  sessionId: "sibling-session",
  status: "done",
  startedAt: 1_000,
  updatedAt: 2_000,
  endedAt: 2_000,
};

async function expectCompletion(target: Parameters<typeof loadEntry>[0], sessionId: string) {
  expect((await loadEntry(target))?.sessionId).toBe(sessionId);
  expect(await readCompletion({ ...target, fallbackEndedAt: 3_000 })).toMatchObject({
    startedAt: 1_000,
    endedAt: 2_000,
    outcome: { status: "ok" },
  });
  expect(await readStartedAt(target)).toBe(1_000);
}

async function completionFor(
  entry = terminalSession,
  childKey = "agent:main:subagent:child",
  storedKey = childKey,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    replaceSessionEntrySync({ sessionKey: storedKey, env: state.env }, entry);
    return readCompletion({
      childSessionKey: childKey,
      fallbackEndedAt: 3_000,
      notBeforeMs: 0,
      cfg: {},
    });
  });
}

it.each([
  ["Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room", true],
  ["agent:main:matrix:group:!Room:server", "agent:main:matrix:group:!room:server", false],
  ["agent:main:signal:group:AbCdEf==", "agent:main:signal:group:abcdef==", false],
] as const)("reconciles key %s with %s: %s", async (child, stored, matches) => {
  const completion = await completionFor(terminalSession, child, stored);
  if (matches) {
    expect(completion).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
  } else {
    expect(completion).toBeNull();
  }
});

it.each([
  ["failed", "error"],
  ["timeout", "timeout"],
] as const)("retains persisted %s diagnostics", async (status, outcome) => {
  const lastRunError = "The synthetic fixture could not load its assigned document.";
  expect(await completionFor({ ...terminalSession, status, lastRunError })).toMatchObject({
    endedAt: 2_000,
    outcome: { status: outcome, error: lastRunError },
  });
  expect(await completionFor({ ...terminalSession, status })).toMatchObject({
    outcome:
      status === "failed"
        ? { status: "error", error: "session completed before registry settled" }
        : { status: "timeout" },
  });
});

it("does not turn an interrupted outcome with an end timestamp into registry completion", async () => {
  expect(await completionFor({ ...terminalSession, status: "interrupted" })).toBeNull();
});

it.each([undefined, "sessions.json", "custom-sessions.json", "shared.sqlite"])(
  "reconciles each agent in store %s",
  async (file) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = file ? state.path(file) : undefined;
      const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
      const targets = ["main", "worker"].flatMap((agentId) =>
        [`agent:${agentId}:subagent:child`, "global"].map((sessionKey) => ({
          agentId,
          sessionKey,
        })),
      );
      for (const target of targets) {
        replaceSessionEntrySync(
          { ...target, storePath, env: state.env },
          { ...terminalSession, sessionId: `${target.agentId}-child` },
        );
      }
      for (const { agentId: childAgentId, sessionKey: childSessionKey } of targets) {
        const target = { childSessionKey, childAgentId, cfg };
        // An explicit shared database has one raw-key namespace; the last global write wins.
        const expectedAgent =
          file === "shared.sqlite" && childSessionKey === "global" ? "worker" : childAgentId;
        await expectCompletion(target, `${expectedAgent}-child`);
      }
      for (const [childSessionKey, childAgentId] of [
        ["agent:main:subagent:child", "worker"],
        ["agent:worker:subagent:child", "main"],
        ["agent::subagent:child", "worker"],
        ["global", undefined],
      ] as const) {
        await expect(loadEntry({ childSessionKey, childAgentId, cfg })).rejects.toThrow(
          "Subagent owning agent is unresolved",
        );
      }
    });
  },
);

it.each(["main", "worker"])("isolates %s incognito completion", async (agentId) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
    const storePath = state.path("custom-sessions.json");
    const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
    const durableKey = `agent:${agentId}:subagent:durable`;
    const childSessionKey = `agent:${agentId}:subagent:incognito-child`;
    replaceSessionEntrySync(
      { agentId, sessionKey: durableKey, storePath, env: state.env },
      { ...terminalSession, sessionId: "durable-child" },
    );
    await replaceSessionEntry(
      { agentId, sessionKey: childSessionKey, storePath, env: state.env },
      { ...terminalSession, sessionId: "incognito-child", incognito: true },
    );

    await expectCompletion({ childSessionKey, cfg }, "incognito-child");
    expect(
      listSessionEntriesReadOnly({ agentId, storePath, env: state.env }).map(
        ({ sessionKey }) => sessionKey,
      ),
    ).toEqual([durableKey]);
    expect(fs.existsSync(incognitoPath)).toBe(false);
  });
});

it("reads subagent lifecycle and policy metadata without decoding unrelated session payloads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents/main/sessions/sessions.json");
    const childSessionKey = "agent:main:subagent:target";
    const options = { cfg: { session: { store: storePath } } };
    const params = { childSessionKey, ...options, fallbackEndedAt: 3000 };
    const depth = () => readDepth(childSessionKey, options);
    const policy = () =>
      withPreparedSessionCapabilityRead(() => readPolicy(childSessionKey, options));
    const writeTarget = (entry: Parameters<typeof replaceSessionEntrySync>[1]) =>
      replaceSessionEntrySync({ storePath, sessionKey: childSessionKey }, entry);
    const lifecycle = {
      ...terminalSession,
      sessionId: "target",
      lifecycleRevision: "target-revision",
    };
    const coldPayload = `TARGET_COLD_PAYLOAD_${"x".repeat(65_536)}`;
    replaceSessionEntrySync(
      { storePath, sessionKey: "agent:main:subagent:other" },
      {
        sessionId: "other",
        updatedAt: 1,
        skillsSnapshot: { prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`, skills: [] },
      },
    );
    writeTarget({
      ...lifecycle,
      skillsSnapshot: { prompt: coldPayload, skills: [] },
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read"],
      inheritedToolDeny: ["exec"],
    });
    const parse = vi.spyOn(JSON, "parse");
    const reads = observeMainThreadReads();
    const messages = vi.spyOn(Worker.prototype, "emit");
    try {
      await expectCompletion(params, "target");
      const transferred = JSON.stringify(
        messages.mock.calls.filter(([event]) => event === "message"),
      );
      expect(transferred).toContain('"sessionId":"target"');
      expect.soft(transferred).not.toContain("TARGET_COLD_PAYLOAD_");
      reads.clear();
      expect(await loadEntry(params)).toMatchObject(lifecycle);
      reads.expectIdle();
      expect.soft(JSON.stringify(parse.mock.calls)).not.toContain("TARGET_COLD_PAYLOAD_");
      expect(await depth()).toBe(2);
      expect(await readDepth("target", options)).toBe(2);
      expect(
        await withPreparedSessionCapabilityRead(() => readCapabilities(childSessionKey, options)),
      ).toMatchObject({ depth: 2, role: "orchestrator" });
      expect(await policy()).toMatchObject({
        spawnedBy: "agent:main:main",
        inheritedToolAllow: ["read"],
        inheritedToolDeny: ["exec"],
      });
      expect(JSON.stringify(parse.mock.calls)).not.toContain("UNRELATED_PAYLOAD_");
    } finally {
      messages.mockRestore();
      reads.restore();
      parse.mockRestore();
    }
    writeTarget({ sessionId: "successor", updatedAt: 4000 });
    expect(await readCompletion(params)).toBeNull();
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteScope({ storePath, sessionKey: childSessionKey })),
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?")
      .run('{"bad":true}', childSessionKey);
    for (const read of [() => readCompletion(params), depth, policy]) {
      await expect(read()).rejects.toThrow("invalid persisted session row requires repair");
    }
  });
});
