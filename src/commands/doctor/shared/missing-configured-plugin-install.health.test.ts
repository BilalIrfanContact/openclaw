// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import {
  channelPluginEntry,
  configuredPlugin,
} from "./missing-configured-plugin-install.test-helpers.js";

const { mocks, testEnv, tempDirs, setupPluginInstallSuite } =
  await import("./missing-configured-plugin-install.suite.test-support.js");
const {
  configuredPluginInstallIssueToHealthFinding: health,
  configuredPluginInstallIssueToRepairEffect: effect,
  detectConfiguredPluginInstallHealthIssues,
} = await import("./missing-configured-plugin-install.js");

async function detect(cfg: OpenClawConfig, env = testEnv) {
  const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
  for (const mock of [
    mocks.installPluginFromClawHub,
    mocks.installPluginFromNpmSpec,
    mocks.resolveNpmSpecMetadata,
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
  expect(issues).toHaveLength(1);
  return expectDefined(issues[0], "health issue");
}

setupPluginInstallSuite();

it.each([false, true])(
  "reports install health without mutation (deferred=%s)",
  async (deferred) => {
    const pluginId = deferred ? "discord" : "matrix";
    const npmSpec = deferred ? "@openclaw/discord" : "@openclaw/plugin-matrix";
    const installPath = path.resolve("/missing/discord");
    if (deferred) {
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
        discord: { source: "npm", spec: npmSpec, installPath },
      });
    }
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      channelPluginEntry({
        id: pluginId,
        npmSpec,
        trustedSourceLinkedOfficialInstall: deferred ? undefined : true,
      }),
    ]);
    const channels = { [pluginId]: { enabled: true } };
    const cfg: OpenClawConfig = {
      ...(deferred ? configuredPlugin(pluginId) : { update: { channel: "beta" } }),
      channels,
    };
    const env = deferred
      ? {
          ...testEnv,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        }
      : testEnv;

    const issue = await detect(cfg, env);
    expect(health(issue)).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      target: pluginId,
      ...(deferred
        ? { path: installPath }
        : { fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix." }),
    });
    expect(effect(issue)).toEqual({
      kind: "package",
      action: deferred
        ? "would-defer-configured-plugin-install-repair"
        : "would-install-configured-plugin",
      target: pluginId,
      dryRunSafe: deferred,
    });
  },
);

const clawhub = "clawhub:demo@1.2.3",
  npm = "@example/demo@1.2.3";
it.each([
  ["clawhub", "clawhub:demo@latest", clawhub, clawhub],
  ["npm", npm, undefined, `npm:${npm}`],
  ["clawhub", undefined, undefined, undefined],
] as const)(
  "preserves empty-project identity: %s %s",
  async (source, spec, resolvedSpec, command) => {
    const installPath = tempDirs.make("openclaw-doctor-empty-plugin-");
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: { source, spec, resolvedSpec, installPath },
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      channelPluginEntry({ id: "demo", label: "Demo", npmSpec: "@example/catalog-demo" }),
    ]);

    const issue = await detect(configuredPlugin("demo"));
    expect(health(issue)).toMatchObject({
      target: "demo",
      source,
      path: installPath,
      fixHint: command
        ? `Run \`openclaw plugins install ${command} --force\` to reinstall the configured plugin package.`
        : "Run `openclaw doctor --fix` to repair the configured plugin install. An exact reinstall command is unavailable because the install record has no package spec.",
    });
  },
);
