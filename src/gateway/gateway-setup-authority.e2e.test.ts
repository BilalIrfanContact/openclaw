import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { bindLlmOperatorAuthority } from "../plugins/runtime/runtime-llm-operator-authority.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ActivateSetupInferenceParams } from "../system-agent/setup-inference.js";
import type { DevicePairingList } from "./device-pairing-list.types.js";
import { startWizardGateway } from "./gateway-wizard.test-support.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

const provider = vi.hoisted(() => ({ activate: vi.fn() }));
// mock-isolation: Pause setup work, not authenticated dispatch, admission or operator capture.
vi.mock("../system-agent/setup-inference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../system-agent/setup-inference.js")>()),
  activateSetupInference: provider.activate,
}));

afterEach(() => {
  provider.activate.mockReset();
  resetGatewayTestState();
});

describe("Gateway setup activation authority", () => {
  it(
    "retains the original operator across reconnect and fences revoked work",
    { timeout: 90_000 },
    async () => {
      let releaseProvider = () => {};
      await using gateway = await startWizardGateway({}, () => releaseProvider());
      let client = await gateway.connect("setup-authority-regression");
      const self = await client.request<UsersSelfResult>("users.self", {});
      expect(self.profile.id).toBe(GATEWAY_OWNER_PROFILE_ID);
      const devices = await client.request<DevicePairingList>("device.pair.list", {});
      expect(devices.paired).toHaveLength(1);
      const deviceId = expectDefined(devices.paired[0], "authenticated setup device").deviceId;
      for (const scenario of [
        { name: "activation", reconnect: false, revoke: "none" },
        { name: "revoked captured completion", reconnect: false, revoke: "after-capture" },
        { name: "revoked reconnected completion", reconnect: true, revoke: "after-capture" },
        { name: "reconnected activation", reconnect: true, revoke: "none" },
        { name: "revoked activation", reconnect: true, revoke: "before-capture" },
        { name: "provider sign-in", reconnect: false, revoke: "none" },
      ] as const) {
        const entered = createDeferredCore();
        const continueProvider = createDeferredCore();
        const captured = createDeferredCore();
        const continueCompletion = createDeferredCore();
        let completionDenied: boolean | undefined;
        releaseProvider = () => {
          continueProvider.resolve();
          continueCompletion.resolve();
        };
        provider.activate.mockImplementationOnce(async (params: ActivateSetupInferenceParams) => {
          const progress = params.prompter?.progress("Testing the selected connection");
          entered.resolve();
          try {
            await continueProvider.promise;
            // Exercise the real runtime LLM owner, without making a provider request.
            const complete = bindLlmOperatorAuthority(
              { kind: "plugin", id: "setup-fixture" },
              async (_input, source) => {
                captured.resolve();
                if (scenario.revoke === "after-capture") {
                  await continueCompletion.promise;
                }
                try {
                  source.assertCurrent();
                  completionDenied = false;
                } catch (error) {
                  completionDenied = true;
                  throw error;
                }
                expect(source.operatorAuthority?.profileId).toBe(GATEWAY_OWNER_PROFILE_ID);
                return {
                  text: "OK",
                  provider: "fixture",
                  model: "verified",
                  agentId: "main",
                  usage: {},
                  execution: {
                    mode: "direct-provider",
                    owner: { kind: "provider", id: "fixture" },
                  },
                  audit: { caller: { kind: "plugin", id: "setup-fixture" } },
                };
              },
            );
            await complete({
              model: "fixture/verified",
              messages: [{ role: "user", content: "Reply OK" }],
            });
            params.assertCurrent?.();
            return { ok: true, modelRef: "fixture/verified", lines: [] };
          } finally {
            progress?.stop();
          }
        });
        const sessionId = scenario.name.replaceAll(" ", "-");
        try {
          const start = await client.request<WizardStartResult>(
            scenario.name === "provider sign-in"
              ? "openclaw.setup.auth.start"
              : "openclaw.setup.activate.start",
            {
              sessionId,
              ...(scenario.name === "provider sign-in"
                ? { authChoice: "fixture" }
                : { kind: "codex-cli" }),
            },
          );
          expect(start).toMatchObject({ sessionId, done: false, status: "running" });
          await entered.promise;
          // A wire round trip lets the start dispatcher finish without a timing sleep.
          await client.request("health", {});
          const progress = await client.request<WizardNextResult>("wizard.next", { sessionId });
          expect(progress.step?.type).toBe("progress");
          if (scenario.revoke === "before-capture") {
            await client.request("device.token.revoke", { deviceId, role: "operator" });
          }
          if (scenario.reconnect) {
            await disconnectGatewayClient(client);
            client = await gateway.connect("setup-authority-reconnected");
          }
          continueProvider.resolve();
          if (scenario.revoke === "after-capture") {
            await captured.promise;
            await client.request("device.token.revoke", { deviceId, role: "operator" });
            await disconnectGatewayClient(client);
            client = await gateway.connect("setup-authority-revocation-observer");
            continueCompletion.resolve();
          }
          const result = await client.request<WizardNextResult>("wizard.next", { sessionId });
          if (scenario.revoke === "after-capture") {
            expect(completionDenied, scenario.name).toBe(true);
          }
          if (scenario.revoke !== "none") {
            // Fresh authentication collects the outcome, never revives the original grant.
            expect(result).toMatchObject({ done: true, status: "error" });
            expect(result.error).toContain("authority");
            expect(result.modelActivation).toBeUndefined();
          } else {
            expect(result.error, scenario.name).toBeUndefined();
            expect(result, scenario.name).toMatchObject({
              done: true,
              status: "done",
              modelActivation: { modelRef: "fixture/verified" },
            });
          }
        } finally {
          releaseProvider();
        }
      }
    },
  );
});
