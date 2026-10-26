import assert from "node:assert/strict";
import path from "node:path";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import {
  directSpawnItem,
  itemNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { readCodexNativeSubagents } from "./native-subagent-roster.js";
import {
  assistantMessage,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createStartedThreadHarness as createProvenanceHarness,
  getRequestInputText,
} from "./run-attempt.context-engine.test-support.js";
import {
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it("reads the running V2 child through the attempt's physical binding without native dispatch", async () => {
  // Native recovery timers cannot add unrelated RPCs during the read assertion.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const lifetime = new AbortController();
  const params = createTestParams();
  params.abortSignal = lifetime.signal;
  const storePath = path.join(tempDir, "native-observation", "sessions.json");
  await attachSqliteSessionTarget(params, storePath, "native-observation-session");
  params.config = { ...params.config, session: { ...params.config?.session, store: storePath } };
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  const host = await createAdmittedHostCapabilityTestFixture(params, {
    nativeModelPolicySupport: "exact",
  });
  assert(host.agentHarnessCompletionScope);
  params.hostCapabilities = host.hostCapabilities;
  params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
  const harness = createStartedThreadHarness(undefined, { persistedThreads: [] });
  const run = runCodexAppServerAttempt(params, {
    bindingStore: testCodexAppServerBindingStore,
    nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
  });
  let selected: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsync>> | undefined;
  try {
    await run.waitForTurnAccepted();
    const binding = await testCodexAppServerBindingStore.readAsync(sessionBindingIdentity(params));
    assert(binding);
    expect(binding.clientId).toBe(harness.client.getInstanceId());
    await harness.notify(
      itemNotification(
        directSpawnItem("v2", binding.threadId, "observation-child"),
        "turn-1",
        binding.threadId,
      ),
    );
    await harness.notify(
      turnStartedNotification("observation-child-turn", { threadId: "observation-child" }),
    );
    const target = params.sessionTarget;
    assert(target?.agentId && target.sessionKey && target.storePath);
    selected = await captureSessionEntryCurrentCheckAsync({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sessionId: params.sessionId,
      storePath: target.storePath,
    });
    assert(selected.entry?.sessionId === params.sessionId);
    assert(selected.entryCurrent);
    const requestsBeforeRead = harness.requests.length;
    const roster = await readCodexNativeSubagents(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: selected.entry.lifecycleRevision,
        storePath: selected.entryCurrent.source.path,
        assertCurrent: selected.source,
      },
      { bindingStore: testCodexAppServerBindingStore },
    );
    expect(roster).toEqual({
      coverage: "live",
      children: [{ id: "observation-child", label: "/root/observation-child", status: "running" }],
      truncated: false,
    });
    expect(harness.requests).toHaveLength(requestsBeforeRead);
    await harness.notify(
      childTurnCompletedNotification({
        threadId: "observation-child",
        turnId: "observation-child-turn",
        status: "interrupted",
      }),
    );
    await harness.completeTurn({ threadId: binding.threadId, turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, promptError: null });
  } finally {
    lifetime.abort("test_cleanup");
    harness.close();
    await Promise.allSettled([run]);
    await nativeHookRelayUnregisterQueue.flush();
    selected?.release();
    host.closeHost();
    host.closeAdmission();
    host.closeGateway();
  }
});

it("reserves native input space for inert sender provenance", async () => {
  const params = createTestParams();
  params.contextEngine = createContextEngine({
    assemble: async () => ({
      messages: [
        ...Array.from({ length: 9 }, (_, index) =>
          assistantMessage("older context " + index + " " + "x".repeat(120_000), index),
        ),
        assistantMessage("recent anchor", 10),
      ],
      estimatedTokens: 300_000,
    }),
  });
  params.contextTokenBudget = 300_000;
  params.trigger = "user";
  params.prompt = "current prompt survives";
  params.senderId = "profile-ada";
  params.senderName = "$metadata-skill";
  const harness = createProvenanceHarness();
  const run = runCodexAppServerAttempt(params);
  await run.waitForTurnAccepted();
  const inputText = getRequestInputText(harness);
  expect(inputText.length).toBe(1 << 20);
  expect(inputText).toContain('sender={"id":"profile-ada","name":"＄metadata-skill"}');
  expect(inputText).toContain("recent anchor");
  expect(inputText).toContain("current prompt survives");
  await harness.completeTurn();
  await run;
});
