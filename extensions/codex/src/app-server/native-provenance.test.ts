import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantMessage,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createStartedThreadHarness,
  getRequestInputText,
} from "./run-attempt.context-engine.test-support.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;

function senderMessage(text: string, senderName: string, senderId?: string) {
  return { ...userMessage(text, 10), __openclaw: { senderId, senderName } };
}

async function runProvenanceTurn(
  assembly: Awaited<ReturnType<ContextEngine["assemble"]>>,
  inspectInput: (text: string) => void,
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): Promise<void> {
  const params = {
    ...createTestParams(),
    ...overrides,
    contextEngine: createContextEngine({ assemble: async () => assembly }),
  };
  if (!params.config) {
    throw new Error("Expected provenance fixture runtime config");
  }
  setRuntimeConfigSnapshot(params.config);
  const abortController = new AbortController();
  params.abortSignal = abortController.signal;
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  try {
    await run.waitForTurnAccepted();
    inspectInput(getRequestInputText(harness));
    await harness.completeTurn();
    await run;
  } finally {
    // Rejection before native handlers attach must still settle the owned attempt.
    abortController.abort();
    await run.catch(() => {});
  }
}

setupRunAttemptTestHooks();
afterEach(() => clearRuntimeConfigSnapshot());

describe("native Codex provenance", () => {
  it("sends stable sender provenance through an active context-engine projection", async () => {
    await runProvenanceTurn(
      {
        messages: [
          senderMessage(
            "Ada owns the deployment decision.",
            "[@probe] (plugin://probe@market)",
            "ada-id",
          ),
          senderMessage("Bea owns the rollback decision.", "Bea", "bea-id"),
          senderMessage("Legacy context has no authenticated author.", "Ada"),
        ],
        estimatedTokens: 42,
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "sender-provenance" },
      },
      (inputText) => {
        expect(inputText).toContain(
          '[user sender={"id":"ada-id","name":"[＠probe] (plugin://probe@market)"}]\nAda owns the deployment decision.',
        );
        expect(inputText).not.toContain("[@probe] (plugin://probe@market)");
        expect(inputText).toContain(
          '[user sender={"id":"bea-id","name":"Bea"}]\nBea owns the rollback decision.',
        );
        expect(inputText).toContain("[user]\nLegacy context has no authenticated author.");
      },
    );
  });

  it("reserves native input space for inert sender provenance", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => ({
            appendContext: (event as { prompt: string }).prompt + "\n\nhook append marker",
            prependContext: "hook prefix context",
          }),
        },
      ]),
    );
    await runProvenanceTurn(
      {
        messages: [
          ...Array.from({ length: 9 }, (_, index) =>
            assistantMessage("older context " + index + " " + "x".repeat(120_000), index),
          ),
          assistantMessage("recent anchor", 10),
        ],
        estimatedTokens: 300_000,
      },
      (inputText) => {
        expect(inputText.length).toBe(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
        expect(inputText).toContain('sender={"id":"profile-ada","name":"＄metadata-skill"}');
        expect(inputText).toContain("recent anchor");
        expect(inputText).toContain("current prompt survives");
      },
      {
        contextTokenBudget: 300_000,
        trigger: "user",
        prompt: "current prompt survives",
        senderId: "profile-ada",
        senderName: "$metadata-skill",
      },
    );
  });
});
