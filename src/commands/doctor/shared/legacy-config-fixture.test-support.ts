import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as pluginMetadata from "../../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";

vi.mock("../../../plugins/setup-registry.js", () => ({
  resolvePluginSetupCliBackend: () => undefined,
  resolvePluginSetupRegistry: () => ({
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  }),
  runPluginSetupConfigMigrations: ({ config }: { config: OpenClawConfig }) => ({
    config,
    changes: [],
  }),
}));

vi.mock("../../../plugins/manifest-registry.js", () => {
  const owners = { brave: "brave", gemini: "google", firecrawl: "firecrawl" };
  const plugins = () =>
    Object.entries(owners).map(([webSearchProvider, id]) => {
      const rootDir = `/plugins/${id}`;
      return {
        id,
        origin: "bundled",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        contracts: { webSearchProviders: [webSearchProvider] },
        rootDir,
        source: `${rootDir}/index.ts`,
        manifestPath: `${rootDir}/openclaw.plugin.json`,
      };
    });
  return {
    loadPluginManifestRegistryCore: () => ({
      diagnostics: [],
      plugins: plugins(),
    }),
    resolveManifestContractOwnerPluginId: ({ value }: { value: string }): string | undefined => {
      return Object.entries(owners).find(([provider]) => provider === value)?.[1];
    },
  };
});

vi.mock("./channel-legacy-config-migrate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-legacy-config-migrate.js")>()),
  applyChannelDoctorCompatibilityMigrations: (cfg: OpenClawConfig) => ({
    next: cfg,
    changes: [],
  }),
}));

export function mockPluginProviders(providers: string[] = []) {
  vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValueOnce(
    createPluginMetadataSnapshotFixture({ plugins: [{ id: "fixture", providers }] }),
  );
}

export function useDoctorLegacyConfigFixture() {
  afterEach(() => vi.restoreAllMocks());
  let previousOauthDir: string | undefined;
  let tempOauthDir = "";
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(() => {
      if (previousOauthDir === undefined) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
      }
      cleanup();
    }),
  );

  beforeAll(() => {
    previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    tempOauthDir = tempDirs.make("openclaw-oauth-");
    process.env.OPENCLAW_OAUTH_DIR = tempOauthDir;
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    fs.rmSync(tempOauthDir, { recursive: true, force: true });
    fs.mkdirSync(tempOauthDir, { recursive: true });
  });

  return {
    seedProviderCatalog(agentId: string) {
      const agentDir = path.join(tempOauthDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "models.json"), '{"providers":{"agent-local":{}}}');
    },
    get oauthDir() {
      return tempOauthDir;
    },
  };
}
