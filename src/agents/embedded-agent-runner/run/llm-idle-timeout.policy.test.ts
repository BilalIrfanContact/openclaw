import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

type TimeoutParams = NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>;
const local = { baseUrl: "http://127.0.0.1:11434" };
const cloud = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
const defaults = (timeoutSeconds: number): OpenClawConfig => ({
  agents: { defaults: { timeoutSeconds } },
});
type Provider = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];
const providerConfig = (baseUrl: string, apiKey: string): Provider => ({
  baseUrl,
  apiKey,
  api: "openai-completions",
  models: [],
});
const withProviders = (providers: Record<string, Provider>): OpenClawConfig => ({
  models: { providers },
});
function expectBudgets(params: TimeoutParams, idle: number, firstEvent = idle) {
  expect(resolveLlmIdleTimeoutMs(params)).toBe(idle);
  expect(resolveLlmFirstEventTimeoutMs(params)).toBe(firstEvent);
}

describe("LLM watchdog policy", () => {
  it.each`
    name                       | params                                              | budget
    ${"short agent budget"}    | ${{ cfg: defaults(30) }}                            | ${30_000}
    ${"explicit local budget"} | ${{ model: local, modelRequestTimeoutMs: 600_000 }} | ${600_000}
  `(
    "resolves idle and first-event budgets: $name",
    ({ params, budget }: { params: TimeoutParams; budget: number }) => {
      expectBudgets(params, budget);
    },
  );

  it("keeps the cloud watchdog finite when the configured run timeout is unlimited", () => {
    const cfg = defaults(0);
    const runTimeoutMs = resolveAgentTimeoutMs({ cfg });
    expect(runTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveLlmIdleTimeoutMs({ cfg, runTimeoutMs, model: cloud })).toBe(120_000);
  });

  it.each([
    ["http://localhost:11434", 0],
    ["http://100.64.0.5:11434", 0],
    ["http://[fe80::1]:11434", 0],
    ["http://172.32.0.1:11434", 120_000],
    ["http://192.169.1.1:11434", 120_000],
  ])("classifies the endpoint without DNS: %s", (baseUrl, expected) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(expected);
  });

  it.each([
    ["gpu", "http://gpu-box:8000/v1", "custom-local", 300_000, 600_000],
    ["custom-proxy", "http://gateway:4000/v1", undefined, 120_000, 60_000],
  ] as const)(
    "uses provider locality evidence for %s at %s",
    (provider, baseUrl, apiKey, idle, cron) => {
      const cfg: OpenClawConfig | undefined = apiKey
        ? withProviders({ [provider]: providerConfig(baseUrl, apiKey) })
        : undefined;
      const model = { provider, baseUrl };
      expectBudgets({ cfg, model }, idle);
      expect(resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 })).toBe(
        cron,
      );
    },
  );

  it.each`
    name                        | entries                              | expected
    ${"normalized key"}         | ${[[" GPU ", true]]}                 | ${300_000}
    ${"canonical key priority"} | ${[[" GPU ", true], ["gpu", false]]} | ${120_000}
    ${"first normalized key"}   | ${[[" GPU ", false], ["GPU", true]]} | ${120_000}
  `(
    "uses $name for configured provider locality",
    ({ entries, expected }: { entries: Array<[string, boolean]>; expected: number }) => {
      const baseUrl = "http://gpu-box:8000/v1";
      const cfg = withProviders(
        Object.fromEntries(
          entries.map(([key, isLocal]) => [
            key,
            providerConfig(baseUrl, isLocal ? "custom-local" : "synthetic-remote"),
          ]),
        ),
      );
      const model = { provider: " GPU ", baseUrl };
      expectBudgets({ cfg, model }, expected);
    },
  );

  it.each([
    ["kimi-k2.5:cloud", "http://127.0.0.1:11434", 0],
    ["gpt-oss:120b-cloud", "http://ollama-box:11434", 300_000],
  ])("keeps hosted watchdogs for custom Ollama model %s through %s", (id, baseUrl, localIdle) => {
    const cfg = withProviders({
      "local-ollama": { ...providerConfig(baseUrl, "ollama-local"), api: "ollama" },
    });
    const model = { provider: "local-ollama", id, baseUrl };
    expect({
      idle: resolveLlmIdleTimeoutMs({ cfg, model }),
      firstEvent: resolveLlmFirstEventTimeoutMs({ cfg, model }),
      cron: resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 }),
      local: resolveLlmIdleTimeoutMs({ cfg, model: { ...model, id: "gemma4:latest" } }),
    }).toEqual({ idle: 120_000, firstEvent: 120_000, cron: 60_000, local: localIdle });
  });
});
