import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import type { MsgContext } from "../templating.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  createModelSelectionState: vi.fn<typeof import("./model-selection.js").createModelSelectionState>(
    async (params) => createModelSelectionStateFixture(params),
  ),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

function reply(home: string, overrides: Partial<MsgContext> = {}, body = "hello") {
  return getReplyFromConfig(
    {
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      SessionKey: "agent:main:whatsapp:+2000",
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "direct",
      ...overrides,
    },
    {},
    makeReplyConfig(home) as OpenClawConfig,
  );
}

function installRuntimeChannels() {
  setActivePluginRegistry(
    createTestRegistry(
      (["whatsapp", "telegram"] as const).map((id) => ({
        pluginId: id,
        plugin: createChannelTestPluginBase({ id }),
        source: "test",
      })),
    ),
  );
}

describe("getReplyFromConfig fast-path runtime", () => {
  beforeAll(async () => {
    installRuntimeChannels();
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));
    installRuntimeChannels();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["native", "normal"] as const)(
    "routes structured %s turns before legacy sync",
    async (kind) => {
      await withTempHome(async (home) => {
        const native = kind === "native";
        const target = "agent:main:telegram:direct:target";
        const source = native ? "telegram:slash:source" : "agent:main:telegram:direct:source";
        await reply(home, {
          ...(!native ? { CommandSource: "native" as const } : {}),
          CommandTurn: native
            ? { kind: "native", source: "native", authorized: true }
            : { kind: "normal", source: "message", authorized: false },
          CommandTargetSessionKey: target,
          SessionKey: source,
          Provider: "telegram",
          Surface: "telegram",
        });

        expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKey: native ? target : source }),
        );
      });
    },
  );
});
