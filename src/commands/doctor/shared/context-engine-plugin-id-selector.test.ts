import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { findContextEnginePluginIdSelector } from "./context-engine-plugin-id-selector.js";

function plugin(
  id: string,
  contextEngineIds?: string[],
  kind: PluginManifestRecord["kind"] = "context-engine",
): PluginManifestRecord {
  return createPluginManifestRecordFixture({
    id,
    kind,
    ...(contextEngineIds ? { contextEngineIds } : {}),
    origin: "global",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
  });
}

function config(contextEngine: string, plugins: OpenClawConfig["plugins"] = {}): OpenClawConfig {
  return {
    plugins: {
      entries: { "vendor-plugin": { enabled: true } },
      ...plugins,
      slots: { contextEngine },
    },
  };
}

const owner = plugin("vendor-plugin", ["MiXeD-Engine"]);
const selected = config("vendor-plugin");
const notEnabled = "is not independently enabled";
function choice(
  name: string,
  policy: OpenClawConfig["plugins"],
  records = [owner],
  message = notEnabled,
): [string, OpenClawConfig, PluginManifestRecord[], string] {
  return [name, config("vendor-plugin", policy), records, message];
}

describe("findContextEnginePluginIdSelector", () => {
  it("replaces a released installer's plugin-ID selector with the single declared engine", () => {
    expect(findContextEnginePluginIdSelector(config("Vendor-Plugin"), [owner])).toEqual({
      kind: "replace",
      selector: "Vendor-Plugin",
      pluginId: "vendor-plugin",
      engineId: "MiXeD-Engine",
    });
  });

  it("accepts an owner approved only through the allowlist", () => {
    expect(
      findContextEnginePluginIdSelector(
        config("vendor-plugin", { allow: ["vendor-plugin"], entries: {} }),
        [owner],
      ),
    ).toMatchObject({ kind: "replace", engineId: "MiXeD-Engine" });
  });

  it.each([
    ["an explicit engine", config("MiXeD-Engine"), [owner]],
    [
      "a plugin ID that is also a declared engine",
      selected,
      [plugin("vendor-plugin", ["other"]), plugin("other-owner", ["vendor-plugin"])],
    ],
    ["an undeclared equal-ID plugin", selected, [plugin("vendor-plugin")]],
    [
      "a non-engine plugin declaration",
      selected,
      [plugin("vendor-plugin", ["MiXeD-Engine"], "memory")],
    ],
    ["legacy", config("legacy"), [plugin("legacy", ["MiXeD-Engine"])]],
    ["none", config("none"), [plugin("none", ["MiXeD-Engine"])]],
    ["disabled plugins", config("vendor-plugin", { enabled: false }), [owner]],
  ] satisfies Array<[string, OpenClawConfig, PluginManifestRecord[]]>)(
    "leaves %s unchanged",
    (_name, cfg, plugins) => {
      expect(findContextEnginePluginIdSelector(cfg, plugins)).toBeUndefined();
    },
  );

  it.each([
    choice(
      "multiple declared engines",
      {},
      [plugin("vendor-plugin", ["engine-a", "engine-b"])],
      "set plugins.slots.contextEngine to one of: engine-a, engine-b",
    ),
    choice(
      "an owner that is not independently enabled",
      { entries: {} },
      [owner],
      'Enable plugins.entries.vendor-plugin or resolve the conflict, then set plugins.slots.contextEngine to "MiXeD-Engine"',
    ),
    choice(
      "a case-equal engine outside a restrictive allowlist",
      { allow: ["other"], entries: {} },
      [plugin("vendor-plugin", ["Vendor-Plugin"])],
    ),
    choice("an enabled owner outside a restrictive allowlist", { allow: ["other"] }),
    choice("a denied owner", { deny: ["vendor-plugin"] }),
    choice(
      "another eligible owner of the same engine",
      { entries: { "vendor-plugin": { enabled: true }, rival: { enabled: true } } },
      [owner, plugin("rival", ["MiXeD-Engine"])],
      "another eligible plugin declares the same engine",
    ),
  ])("keeps the selector and asks for a choice with %s", (_name, cfg, plugins, message) => {
    const finding = findContextEnginePluginIdSelector(cfg, plugins);
    expect(finding?.kind).toBe("choose");
    expect(finding && "message" in finding ? finding.message : "").toContain(message);
  });
});
