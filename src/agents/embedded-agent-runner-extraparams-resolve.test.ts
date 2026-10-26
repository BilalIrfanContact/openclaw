import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./embedded-agent-runner/extra-params.js";

const gpt5Defaults = { parallel_tool_calls: true, text_verbosity: "low" };

describe("resolveExtraParams", () => {
  it.each([
    ["applies default runtime params for OpenAI GPT-5 models", "openai", gpt5Defaults],
    ["does not apply OpenAI GPT-5 defaults to OpenRouter models", "openrouter", undefined],
  ] as const)("%s", (_name, provider, expected) => {
    expect(resolveExtraParams({ cfg: undefined, provider, modelId: "gpt-5.4" })).toEqual(expected);
  });

  it.each([
    ["returns params for exact provider/model key", "gpt-4"],
    ["ignores unrelated model entries", "gpt-4.1-mini"],
  ] as const)("%s", (_name, modelId) => {
    const params = { temperature: 0.7, maxTokens: 2048 };
    expect(
      resolveExtraParams({
        cfg: { agents: { defaults: { models: { "openai/gpt-4": { params } } } } },
        provider: "openai",
        modelId,
      }),
    ).toEqual(modelId === "gpt-4" ? params : undefined);
  });

  it("merges per-agent params over global model defaults", () => {
    // Agent-specific params are narrower than model defaults and must win on
    // overlapping keys.
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  temperature: 0.5,
                  cacheRetention: "long",
                },
              },
            },
          },
          entries: { "risk-reviewer": { params: { cacheRetention: "none" } } },
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "risk-reviewer",
    });

    expect(result).toEqual({
      temperature: 0.5,
      cacheRetention: "none",
    });
  });

  it.each([
    ["gpt-4.1", "parallel_tool_calls", "parallelToolCalls", true, false],
    ["gpt-5.4", "text_verbosity", "textVerbosity", "high", "low"],
    ["gpt-5.4", "response_format", "responseFormat", { type: "text" }, { type: "json_object" }],
  ] as const)(
    "canonicalizes agent overrides for %s: %s",
    (modelId, canonical, alias, modelValue, agentValue) => {
      expect(
        resolveExtraParams({
          cfg: {
            agents: {
              defaults: {
                models: { [`openai/${modelId}`]: { params: { [canonical]: modelValue } } },
              },
              entries: { main: { params: { [alias]: agentValue } } },
            },
          },
          provider: "openai",
          modelId,
          agentId: "main",
        }),
      ).toEqual({ ...(modelId === "gpt-5.4" ? gpt5Defaults : {}), [canonical]: agentValue });
    },
  );

  it("ignores per-agent params when agentId does not match", () => {
    expect(
      resolveExtraParams({
        cfg: {
          agents: {
            entries: { "risk-reviewer": { params: { cacheRetention: "none" } } },
          },
        },
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        agentId: "main",
      }),
    ).toBeUndefined();
  });
});
