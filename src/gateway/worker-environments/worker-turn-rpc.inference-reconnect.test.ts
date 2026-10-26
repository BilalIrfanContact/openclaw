import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore, type WorkerInferenceStore } from "./inference-store.js";
import { createSink, DONE } from "./inference.test-support.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimAdmission, claimTarget, seedClaim } from "./worker-turn-rpc-fixtures.test-support.js";

support.setupWorkerEnvironmentServiceSuite();

it.each(["source replacement", "transport refresh"] as const)(
  "retains the original source across %s while BEGIN is pending",
  async (change) => {
    const environmentId = "inference-reconnect-worker";
    const sessionId = "inference-reconnect-session";
    const {
      claim,
      store: placements,
      environmentIdentity: environment,
    } = await seedClaim(environmentId, sessionId);
    const instance = createOperationalRunInstanceRef(claim.runId);
    const authority = claimAgentRunDelegatedAuthority(instance);
    const target = claimTarget(sessionId);
    const bind = () =>
      bindWorkerTurnOwner(placements, claim, undefined, instance, target, () => {
        if (!placements.validateTurnClaim(claim)) {
          throw new Error("Reconnect fixture lost its real placement claim");
        }
      });
    await bind();
    const entered = createDeferred();
    const proceed = createDeferred();
    const nativeStore = createWorkerInferenceStore({
      path: support.testState.stateDb.path,
      now: () => support.testState.nowMs,
    });
    const begin = vi.fn<WorkerInferenceStore["begin"]>(async (...args) => {
      entered.resolve();
      await proceed.promise;
      return nativeStore.begin(...args);
    });
    const execute = vi.fn(async () => DONE);
    const rpc = support.createService(support.createProvider(), {
      executeInference: execute,
      inferenceStore: { ...nativeStore, begin },
      placementStore: createWorkerSessionPlacementGate(placements),
    });
    let first: ReturnType<typeof rpc.startInference> | undefined;
    let reconnected: ReturnType<typeof rpc.startInference> | undefined;
    const renewCredential = async (credential: string) => {
      const credentialHash = hashWorkerCredential(credential, claim);
      await support.testState.store.renewCredential({
        environmentId,
        expectedOwnerEpoch: environment.ownerEpoch,
        credentialHash,
        sessionId,
        rpcSetVersion: environment.rpcSetVersion,
        expiresAtMs: environment.credentialExpiresAtMs,
      });
      return credentialHash;
    };
    try {
      const credential = "inference-reconnect-fixture";
      await renewCredential(credential);
      const admission = await rpc.admitWorker(claimAdmission(claim, credential));
      assert(admission.ok, "Reconnect fixture worker admission failed");
      const identity = admission.identity;
      const request = support.inferenceRequest(identity);
      const firstSink = createSink("original-connection");
      const nextSink = createSink("reconnected-connection");
      first = rpc.startInference(identity, request, firstSink.sink);
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "Inference resolved before its BEGIN gate",
      );
      let nextIdentity = identity;
      if (change === "source replacement") {
        // Same claim, run, target, and registry authority; only the bound source owner changes.
        await bind();
      } else {
        const credentialHash = await renewCredential("reconnected-fixture");
        nextIdentity = { ...identity, credentialHash };
      }
      reconnected = rpc.startInference(nextIdentity, request, nextSink.sink);
      proceed.resolve();
      const results = await Promise.all([first, reconnected]);
      if (change === "source replacement") {
        const refused = { ok: false, reason: "provider-error" };
        expect(results).toEqual([refused, refused]);
        expect(execute).not.toHaveBeenCalled();
        expect(nextSink.frames).toEqual([]);
      } else {
        for (const result of results) {
          assert(result.ok, "Current source could not reconnect its transport");
          expect(result.result.status).toBe("accepted");
          result.launch();
        }
        expect((await nextSink.terminal).payload.outcome).toEqual(DONE);
        expect(execute).toHaveBeenCalledOnce();
      }
      expect(firstSink.frames).toEqual([]);
      expect(begin).toHaveBeenCalledOnce();
    } finally {
      proceed.resolve();
      await Promise.allSettled([first, reconnected]);
      await Promise.allSettled([rpc.stop()]);
      await placements.releaseTurn(claim);
      releaseAgentRunDelegatedAuthority(authority);
    }
  },
);
