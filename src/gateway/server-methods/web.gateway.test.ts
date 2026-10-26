import { afterEach, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { dispatchAuthorizationRequest as dispatch } from "../server-methods.authorization.test-support.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { expectRpcResult } from "./rpc-response.test-support.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(resetPluginRuntimeStateForTest);

function registryEntry(id: string, start: ReturnType<typeof vi.fn>, aliases: string[] = []) {
  return {
    pluginId: id,
    source: "test",
    plugin: {
      id,
      config: { listAccountIds: () => ["default"] },
      meta: { aliases },
      gatewayMethods: ["web.login.start"],
      gateway: { loginWithQrStart: start },
    },
  };
}

function requestContext() {
  const cfg = {};
  return {
    getRuntimeConfig: () => cfg,
    isConfigReloadSettled: () => true,
    getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
    stopChannel: vi.fn(),
    startChannel: vi.fn(),
  } as unknown as GatewayRequestContext;
}

it("routes explicit selectors through the registry attached to the request", async () => {
  const globalWhatsappStart = vi.fn();
  const scopedWeixinStart = vi.fn().mockResolvedValue({ connected: true });
  setActivePluginRegistry(createTestRegistry([registryEntry("whatsapp", globalWhatsappStart)]));
  const respond = await dispatch(
    "web.login.start",
    { channel: "wechat" },
    {
      methodRegistry: {
        ...createRequestGatewayMethodRegistry(),
        pluginRegistry: createTestRegistry([
          registryEntry("openclaw-weixin", scopedWeixinStart, ["wechat"]),
        ]),
      },
      client: null,
      context: requestContext(),
    },
    "scoped",
  );

  expect(globalWhatsappStart).not.toHaveBeenCalled();
  expectRpcResult(respond, { connected: true });
});
