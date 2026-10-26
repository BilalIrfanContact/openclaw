import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperatorApprovalSessionEventRuntime } from "../operator-approval-session-events.js";
import { createPendingRecord } from "../operator-approval-session-events.test-support.js";
import * as store from "../operator-approval-store.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

afterEach(() => vi.restoreAllMocks());

it("shares approval replay across 64 subscribers during unrelated approval activity", () =>
  withOpenClawTestState({ layout: "state-only", prefix: "subscribe-approval-perf-" }, async () => {
    const databaseOptions = { env: process.env };
    const sessionKey = "agent:main:perf";
    const records: store.OperatorApprovalRecord[] = [];
    const presentation = createPendingRecord().presentation;
    for (let index = 0; index <= 200; index += 1) {
      const sourceSessionKey = index < 200 ? sessionKey : `${sessionKey}-unrelated`;
      const id = `approval-${String(index).padStart(3, "0")}`;
      const inserted = await store.insertOperatorApproval({
        databaseOptions,
        approval: {
          id,
          presentation,
          createdAtMs: 1000 + index,
          expiresAtMs: 60_000,
          kind: "exec",
          runtimeEpoch: "synthetic-epoch",
          source: { agentId: "main", sessionKey: sourceSessionKey },
          audienceSessionKeys: [sourceSessionKey],
          reviewerDeviceIds: ["reviewer"],
        },
      });
      assert(inserted.outcome === "inserted", "Expected a new synthetic approval");
      records.push(inserted.record);
    }
    const unrelated = records.pop()!;
    const expected = Array.from({ length: 200 }, (_, index) =>
      expect.objectContaining({ id: `approval-${String(index).padStart(3, "0")}` }),
    );
    const clients = Array.from({ length: 64 }, (_, index) => ({
      connId: `subscriber-${index}`,
      connect: { client: { id: "test" }, scopes: ["operator.admin"] },
    })) as GatewayClient[];
    const subscribers = createSessionMessageSubscriberRegistry();
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const runtime = createOperatorApprovalSessionEventRuntime({
      clients,
      sessionMessageSubscribers: subscribers,
      broadcastToConnIds: () => {},
    });
    const prepare = store.prepareOperatorApprovalReplay;
    const preparations = vi
      .spyOn(store, "prepareOperatorApprovalReplay")
      .mockImplementation(async (params) => {
        const result = await prepare(params);
        runtime.publish({ phase: "pending", record: unrelated });
        return result;
      });
    const context = {
      getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
      subscribeSessionMessageEvents: subscribers.subscribe,
      listSessionPendingApprovals: runtime.replay,
      logGateway: { error: vi.fn() },
    } as unknown as GatewayRequestContext;
    for (let round = 0; round < 2; round += 1) {
      const responses = await Promise.all(
        clients.map(async (client) => {
          const respond = vi.fn();
          await sessionSubscriptionHandlers["sessions.messages.subscribe"]!({
            req: { type: "req", id: "perf", method: "sessions.messages.subscribe" },
            params: { key: sessionKey, includeApprovals: true },
            client,
            context,
            respond,
            isWebchatConnect: () => false,
          } satisfies GatewayRequestHandlerOptions);
          return respond;
        }),
      );
      for (const respond of responses) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            approvalReplay: expect.objectContaining({ approvals: expected }),
          }),
          undefined,
        );
      }
      expect(preparations).toHaveBeenCalledTimes(round + 1);
    }
  }));
