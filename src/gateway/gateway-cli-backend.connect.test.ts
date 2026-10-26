import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { WebSocketServer } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";

const timeoutMs = 1_000;

async function startMinimalGatewayServer(params: { token: string }) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: string[] = [];
  let connectParams: Record<string, unknown> | undefined;

  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      requests.push(frame.method ?? "");
      if (frame.method === "connect") {
        connectParams = frame.params as Record<string, unknown> | undefined;
        expect(frame.params).toMatchObject({
          auth: { token: params.token },
          device: { nonce: "test-nonce" },
        });
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            methods: ["health"],
          }),
        );
        return;
      }
      if (frame.method === "health") {
        sendMinimalGatewayResponse(ws, frame.id, { ok: true });
      }
    });
  });

  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const address = wss.address() as AddressInfo;
  return {
    requests,
    get connectParams() {
      return connectParams;
    },
    url: `ws://127.0.0.1:${address.port}`,
    close: () => closeMinimalGatewayServer(wss),
  };
}

describe("gateway cli backend connect", () => {
  beforeEach(async () => {
    const state = await createOpenClawTestState({ scenario: "minimal" });
    onTestFinished(() => state.cleanup());
  });

  it.each([
    { label: "default capabilities", caps: undefined },
    { label: "plugin approval capability", caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS] },
  ])(
    "connects a test gateway client through the live helper with $label",
    async ({ caps }) => {
      const token = `test-${Date.now()}`;
      const deviceIdentity = loadOrCreateDeviceIdentity();
      const server = await startMinimalGatewayServer({ token });
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;

      try {
        // Actor preparation leaves its command runtime lazy. Join a real fixture read
        // before timing the handshake, which still loads fresh token facts itself.
        await expect(
          loadDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role: "operator" }),
        ).resolves.toBeNull();
        client = await connectTestGatewayClient({
          url: server.url,
          token,
          deviceIdentity,
          timeoutMs,
          maxAttemptTimeoutMs: timeoutMs,
          ...(caps ? { caps } : {}),
          requestTimeoutMs: timeoutMs,
          waitForEventLoopReady: false,
        });
        const health = await client.request("health", undefined, { timeoutMs });
        expect(health.ok).toBe(true);
        expect(server.connectParams).toMatchObject({
          client: {
            id: GATEWAY_CLIENT_NAMES.TEST,
            displayName: "vitest-live",
            version: "dev",
            mode: GATEWAY_CLIENT_MODES.TEST,
          },
        });
        expect(server.connectParams?.caps).toEqual(caps ?? []);
        expect(server.requests).toEqual(["connect", "health"]);
      } finally {
        await client?.stopAndWait({ timeoutMs }).catch(() => {});
        await server.close();
      }
    },
    15_000,
  );
});
