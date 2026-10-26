import type { ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  resolveFamilyForwardCompatModel,
} from "../plugin-sdk/provider-model-shared.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

const provider = "test-provider";
const modelId = "next-model";
const identity = { id: modelId, name: modelId, provider };

function template(id: string, patch: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return { id, name: id, provider, api: "openai-completions", ...patch } as ProviderRuntimeModel;
}

function context(models: ProviderRuntimeModel[]): ProviderResolveDynamicModelContext {
  return {
    provider,
    modelId,
    modelRegistry: {
      find: (owner: string, id: string) =>
        models.find((model) => model.provider === owner && model.id === id) ?? null,
    } as ModelRegistry,
  };
}

type CloneParams = Parameters<typeof cloneFirstTemplateModel>[0];
function clone(params: Partial<CloneParams>, models = [template("template-a")]) {
  return cloneFirstTemplateModel({
    providerId: provider,
    modelId,
    templateIds: ["template-a"],
    ctx: context(models),
    ...params,
  });
}
const transport = { api: "anthropic-messages", baseUrl: "https://models.example" } as const;

it("clones the first matching template and normalizes its patched transport", () => {
  const original = template("template-a", { name: "Template A" });
  const model = clone(
    {
      modelId: " next-model ",
      templateIds: ["missing", "template-a", "template-b"],
      patch: { reasoning: true, ...transport, baseUrl: transport.baseUrl + "/v1" },
    },
    [original],
  );
  expect(model).toEqual(template(modelId, { ...transport, reasoning: true }));
  expect([original.api, original.baseUrl]).toEqual(["openai-completions", undefined]);
});

it("returns undefined when no template exists", () => {
  expect(clone({ templateIds: ["missing"] }, [])).toBeUndefined();
});

it.each([
  ["MiniMax-M2.7", "minimax-m2.7", true],
  ["minimax-m2.7-highspeed", "MiniMax-M2.7", true],
  ["glm-5", "minimax-m2.7", false],
] as const)("matchesExactOrPrefix: %s against prefix %s: %s", (id, candidate, expected) => {
  expect(matchesExactOrPrefix(id, [candidate])).toBe(expected);
});

type FamilyParams = Parameters<typeof resolveFamilyForwardCompatModel>[0];
function family(
  models: ProviderRuntimeModel[],
  entry: FamilyParams["cases"][number],
  options: Pick<FamilyParams, "preserveExisting" | "synthesize"> = {},
) {
  return resolveFamilyForwardCompatModel({
    providerId: provider,
    ctx: context(models),
    cases: [entry],
    ...options,
  });
}

it.each([false, true])("normalizes a family model with a cross-provider template=%s", (found) => {
  const patch = { ...transport, provider, baseUrl: transport.baseUrl + "/v1/", reasoning: true };
  const model = family(
    found ? [template("template-b", { provider: "template-provider", reasoning: false })] : [],
    {
      match: (id) => id === modelId,
      templateSources: [
        { templateIds: ["missing"] },
        { providerId: "template-provider", templateIds: ["template-b"] },
      ],
      patch: found
        ? patch
        : ({ normalizedModelId }) => ({ ...patch, reasoning: normalizedModelId === modelId }),
    },
    { synthesize: !found },
  );
  expect(model).toMatchObject({ ...identity, ...transport, reasoning: true });
});

it.each([true, false])("preserves existing rows only after a family matches (%s)", (matches) => {
  const existing = template(modelId, {
    ...transport,
    baseUrl: transport.baseUrl + "/v1",
  });
  const patch = { name: "must-not-replace-existing" };
  const entry = { match: () => matches, patch };
  const model = family([existing], entry, { preserveExisting: true, synthesize: true });
  expect(model).toBe(matches ? existing : undefined);
  expect(existing.baseUrl).toBe("https://models.example/v1");
});
