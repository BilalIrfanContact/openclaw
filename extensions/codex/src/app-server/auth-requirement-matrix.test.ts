import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  resolveCodexAppServerPreparedAuthHandoff,
} from "./auth-bridge.js";
import { createCodexTestOAuthProfile } from "./test-support.js";

const AGENT_DIR = "/tmp/openclaw-codex-auth-matrix";
const SUBSCRIPTION_REQUIRED_ERROR = "subscription profile required";

type StoredProfileKind = "oauth" | "api_key" | "none";
type AuthRequirement = "subscription" | "api-key" | undefined;

function buildStore(kind: StoredProfileKind): AuthProfileStore {
  if (kind === "none") {
    return { version: 1, profiles: {} };
  }
  return {
    version: 1,
    profiles: {
      "openai:default":
        kind === "oauth"
          ? createCodexTestOAuthProfile("matrix-account")
          : { type: "api_key", provider: "openai", key: "matrix-api-key" },
    },
    order: { openai: ["openai:default"] },
  };
}

const handoffDefaults = {
  agentDir: AGENT_DIR,
  subscriptionProfileRequiredError: SUBSCRIPTION_REQUIRED_ERROR,
  subscriptionProfileUnusableError: "subscription profile unusable",
};

const nativeProfile = (nativeAuthProfile: boolean) => ({
  authProfileId: "openai:default",
  nativeAuthProfile,
});
type HandoffResult = Record<string, unknown> | string;
type Handoff = [AuthRequirement, StoredProfileKind, HandoffResult];
const HANDOFF_MATRIX: Handoff[] = [
  ["subscription", "api_key", SUBSCRIPTION_REQUIRED_ERROR],
  ["subscription", "none", SUBSCRIPTION_REQUIRED_ERROR],
  [undefined, "oauth", nativeProfile(true)],
  [undefined, "api_key", nativeProfile(false)],
  [undefined, "none", { authProfileId: undefined, nativeAuthProfile: false }],
];

it.each(HANDOFF_MATRIX)(
  "resolves agent-home authRequirement=%s storedProfile=%s",
  async (authRequirement, storedProfile, expected) => {
    const authProfileId = storedProfile === "none" ? undefined : "openai:default";
    const handoff = resolveCodexAppServerPreparedAuthHandoff({
      authRequirement,
      authProfileId,
      authProfileStore: buildStore(storedProfile),
      ...handoffDefaults,
      homeScope: "agent",
    });

    if (typeof expected === "string") {
      await expect(handoff).rejects.toThrow(expected);
    } else {
      expect(await handoff).toEqual(expected);
    }
  },
);

const NATIVE_ACCOUNT_MATRIX: [AuthRequirement, string | null, "accepts" | "rejects"][] = [
  ["subscription", null, "rejects"],
  // Custom providers need not report an OpenAI account.
  ["api-key", "amazonBedrock", "accepts"],
  ["api-key", null, "accepts"],
  [undefined, "chatgpt", "accepts"],
];

it.each(NATIVE_ACCOUNT_MATRIX)(
  "authRequirement=%s native account=%s %s",
  async (authRequirement, accountType, expected) => {
    const account = accountType === null ? null : { type: accountType };
    const request = vi.fn(async () => ({ account }));
    const apply = applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: AGENT_DIR,
      authProfileId: null,
      authRequirement,
    });

    if (expected === "rejects") {
      await expect(apply).rejects.toMatchObject({ status: 401 });
    } else {
      await expect(apply).resolves.toBeUndefined();
    }
  },
);
