import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), snapshot: vi.fn() }));
// mock-isolation: CLI discovery uses fixture registries without loading plugin runtimes.
vi.mock("./loader.js", () => ({ loadOpenClawPluginCliRegistry: mocks.load }));
// mock-isolation: Metadata selection uses the fixture snapshot, never host config or plugin state.
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: mocks.snapshot,
}));
// mock-isolation: Explicit fixture enablement keeps auto-detection outside descriptor discovery proof.
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({
    config,
    changes: [],
    autoEnabledReasons: {},
  }),
}));
vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  resolvePluginMetadataSnapshot: mocks.snapshot,
}));

const descriptor = (name: string, description: string) => ({
  name,
  description,
  hasSubcommands: true,
});
const matrixPlugin = {
  id: "matrix",
  origin: "bundled" as const,
  format: "openclaw" as const,
  cliCommands: [descriptor("matrix", "Matrix channel utilities")],
};
const legacyPlugin = { id: "legacy-cli", origin: "config" as const, format: "openclaw" as const };
const snapshot = (...plugins: Array<Partial<PluginManifestRecord> & { id: string }>) =>
  createPluginMetadataSnapshotFixture({ plugins });
beforeEach(() => {
  mocks.load.mockReset();
  mocks.snapshot.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.each(["manifest", "legacy", "broken"] as const)(
  "loads %s root help under enabled policy",
  async (mode) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const descriptors = [descriptor("legacy", "Legacy external command")];
    const sibling = {
      id: "external-cli",
      origin: "global" as const,
      format: "openclaw" as const,
      cliCommands: [{ ...descriptor("external-cli", "External utilities"), hasSubcommands: false }],
    };
    const metadata = snapshot(
      { ...matrixPlugin, cliCommands: [...matrixPlugin.cliCommands, ...matrixPlugin.cliCommands] },
      sibling,
      legacyPlugin,
    );
    metadata.index.plugins.splice(1, 0, {
      ...metadata.index.plugins[0]!,
      enabledByDefault: false,
    });
    mocks.snapshot.mockReturnValue(metadata);
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          matrix: { enabled: mode !== "legacy" },
          "external-cli": { enabled: mode === "legacy" },
          "legacy-cli": { enabled: mode !== "manifest" },
        },
      },
    };
    if (mode === "broken") {
      mocks.load.mockRejectedValue(new Error("broken legacy CLI plugin"));
    } else {
      mocks.load.mockResolvedValue({ cliRegistrars: [{ parentPath: [], descriptors }] });
    }
    await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(
      mode === "legacy" ? [...sibling.cliCommands, ...descriptors] : matrixPlugin.cliCommands,
    );
    if (mode === "manifest") {
      config.plugins!.entries!.matrix = { enabled: false };
      config.plugins!.entries!["external-cli"] = { enabled: true };
      await expect(getPluginCliCommandDescriptors(config)).resolves.toEqual(sibling.cliCommands);
      expect(mocks.load).not.toHaveBeenCalled();
    }
    expect(stderr).not.toHaveBeenCalled();
  },
);
