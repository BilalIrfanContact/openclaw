import { expect, it } from "vitest";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import {
  readWorkerPreparation,
  readWorkerProjectPreparation,
} from "./preparation-identity.schema.js";
import type { WorkerLocalProjectSnapshot } from "./workspace-git-base.js";

const input: Omit<Parameters<typeof createWorkerPreparationIdentity>[0], "project"> & {
  project: WorkerLocalProjectSnapshot;
} = {
  namespace: "gateway-one",
  providerId: "fake",
  profileId: "development",
  profileSnapshot: {
    install: "bundle",
    settings: { region: "test", disk: 20 },
    executionMode: "worker-turn",
  },
  project: { key: "a".repeat(64), root: "/source/first-worktree", baseCommit: "b".repeat(40) },
  target: { machineClass: "small", platform: "linux", arch: "x64" },
  artifacts: {
    nodeBootstrapSha256: "c".repeat(64),
    enabledPluginIds: ["second", "first"],
    workerBundleHash: "d".repeat(64),
    workerArchiveSha256: "e".repeat(64),
    openclawVersion: "2026.8.1",
    protocolFeatures: ["worker-inference-v1"],
  },
  setupRecipe: "f".repeat(40),
};
const { project: _project, setupRecipe: _setupRecipe, ...runtime } = input;
type InputChange = Partial<typeof input>;
const identity = (change: InputChange = {}) =>
  createWorkerPreparationIdentity({
    ...input,
    ...change,
    profileSnapshot: { ...input.profileSnapshot, ...change.profileSnapshot },
  });
const project = (change: Partial<typeof input.project>) => ({
  project: { ...input.project, ...change },
});
const target = (change: Partial<typeof input.target>) => ({
  target: { ...input.target, ...change },
});
const artifacts = (change: Partial<typeof input.artifacts>) => ({
  artifacts: { ...input.artifacts, ...change },
});
const original = identity();

it("keeps empty runtime preparation separate from project content", () => {
  const preparation = createWorkerPreparationIdentity(runtime);
  const empty = { source: "empty", ...preparation };
  expect(preparation.key).not.toBe(original.key);
  expect(preparation).not.toHaveProperty("setupRecipe");
  expect(readWorkerPreparation({ ...runtime.profileSnapshot, runtimePreparation: empty })).toEqual(
    empty,
  );
  const rejects = (profile: Record<string, unknown>) =>
    expect(() => readWorkerPreparation(profile)).toThrow("runtime preparation identity is invalid");
  rejects({ project: input.project, runtimePreparation: empty });
  rejects({ runtimePreparation: { ...empty, recipe: { source: "none", inputs: {}, env: {} } } });
});

it("shares identity across linked source paths, JSON field order and plugin order", () => {
  const equivalent = structuredClone(input);
  equivalent.project.root = "/source/second-worktree";
  equivalent.profileSnapshot = {
    executionMode: "worker-turn",
    settings: { disk: 20, region: "test" },
    install: "bundle",
    machineClass: "small",
  };
  equivalent.artifacts.enabledPluginIds.reverse();
  expect(createWorkerPreparationIdentity(equivalent)).toEqual(original);
});

it("separates skipped setup caches while preserving the default identity", () => {
  const enabled = identity({ runSetupScript: true });
  expect(enabled).toEqual(original);
  expect(original).not.toHaveProperty("runSetupScript");
  const skipped = identity({ runSetupScript: false });
  expect(skipped.setupRecipe).toBe(original.setupRecipe);
  expect(skipped.runSetupScript).toBe(false);
  expect(skipped.key).not.toBe(original.key);
  expect(skipped.cacheKey).not.toBe(original.cacheKey);
  expect(readWorkerProjectPreparation({ preparation: skipped })).toEqual(skipped);
});

it("uses the provider disk fingerprint independently of lease and runtime policy", () => {
  const diskTarget = { ...input.target, profileKey: "7".repeat(64) };
  const disk = identity({ target: diskTarget });
  // These digests pin warm-image compatibility across updates.
  expect(disk.key).toBe("cbdf7035128e74fcf4571c1d9c8f5a0b11e1c8e00bd516556c755bd5b495c559");
  expect(disk.cacheKey).toBe("5aa1bd824e0e251412000829f6a7932ef884b12223a29d19611c17a769abc474");
  const changed = identity({
    target: diskTarget,
    profileId: "renamed",
    profileSnapshot: {
      install: "npm",
      executionMode: "remote-exec",
      suspendAfter: "45m",
      readyWorkers: 0,
      settings: { ttl: "4h", idleTimeout: "2h", binary: "/other/crabbox", warmImage: true },
    },
  });
  expect(changed.cacheKey).toBe(disk.cacheKey);
  expect(changed.key).not.toBe(disk.key);
  expect(identity(target({ profileKey: "8".repeat(64) })).cacheKey).not.toBe(disk.cacheKey);
});

it.each<[string, InputChange, boolean?]>([
  ["namespace", { namespace: "gateway-two" }],
  ["provider", { providerId: "another-provider" }],
  ["profile id", { profileId: "another-profile" }, false],
  ["commit", project({ baseCommit: "1".repeat(40) }), false],
  ["recipe", { setupRecipe: "2".repeat(40) }],
  ["profile", { profileSnapshot: { settings: { region: "elsewhere" } } }],
  ["project", project({ key: "9".repeat(64) })],
  ["class", target({ machineClass: "large" })],
  ["target", target({ arch: "arm64" })],
  ["OS", target({ platform: "darwin" })],
  ["mode", { profileSnapshot: { executionMode: "remote-exec" } }, false],
  ["version", artifacts({ openclawVersion: "2026.9.1" }), false],
  ["archive", artifacts({ workerArchiveSha256: "6".repeat(64) }), false],
  ["runtime", artifacts({ nodeBootstrapSha256: "3".repeat(64) }), false],
  ["plugins", artifacts({ enabledPluginIds: ["third"] }), false],
  ["bundle", artifacts({ workerBundleHash: "4".repeat(64) }), false],
  ["protocol", artifacts({ protocolFeatures: ["worker-computer-v1"] }), false],
])("invalidates a changed %s before allocation", (_label, change, cacheChanges = true) => {
  const next = identity(change);
  expect(next.key).not.toBe(original.key);
  expect(next.cacheKey === original.cacheKey).toBe(!cacheChanges);
});
