import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  manifestCaptureOutput,
  seedNodeWorkspaceRepositories,
  unchangedWorkspaceUpload,
  workspaceActions,
  workspaceCommandResult,
  workspaceSnapshot,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const source = (root: string, ref = "test") => ({
  kind: "local" as const,
  path: root,
  stagedResult: { ref: `refs/openclaw/worker-results/${ref}`, record: () => {} },
  journal: {
    load: async () => undefined,
    begin: async () => {},
    commit: async () => {},
    abort: async () => {},
  },
});

it.each([false, true])(
  "requests result v2 only when the worker supports it (%s)",
  async (supported) => {
    const prepareUpload = vi.fn(() => "upload-token");
    const revoke = vi.fn(async () => {});
    const finished = new Error("request captured");
    const baseManifestRef = `sha256:${"a".repeat(64)}`;
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      expect(command.transfer).toEqual({
        direction: "upload",
        token: "upload-token",
        baseManifestRef,
        referenceManifestRef: baseManifestRef,
        ...(supported ? { resultVersion: 2 } : {}),
      });
      throw finished;
    });
    const workspace = {
      source: source("/fixture"),
      remoteWorkspaceDir: "/worker",
      baseManifestRef,
    };
    const actions = workspaceActions({
      environmentId: "environment",
      sessionId: "session",
      supportsGitResults: async () => supported,
      restoredWorkspace: { ...workspace, manifestRef: baseManifestRef },
      workspaceTransfer: workspaceTransfer({ prepareUpload, revoke }),
      runWorkspaceCommand,
    });
    await expect(actions.reconcileWorkspace(workspace)).rejects.toBe(finished);
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    expect(prepareUpload).toHaveBeenCalledWith(
      "environment",
      baseManifestRef,
      undefined,
      supported ? 2 : undefined,
    );
    expect(revoke).toHaveBeenCalledWith("environment", "upload-token");
  },
);

it("rejects a changed worker HEAD even when the working tree still matches", async () => {
  const localPath = temporary.make("node-result-head-local-");
  const remotePath = path.join(temporary.make("node-result-head-remote-"), "workspace");
  await fs.writeFile(path.join(localPath, "tracked.txt"), "same tree\n");
  const baseCommit = seedNodeWorkspaceRepositories(localPath, remotePath);
  const captured = await captureWorkspaceManifest({ root: localPath, baseCommit });
  const snapshot = workspaceSnapshot(localPath, captured.manifest);
  const uploaded = {
    ...unchangedWorkspaceUpload(snapshot, temporary.make("node-result-head-staging-")),
    gitHistory: { baseCommit, headCommit: baseCommit, descendsFromBase: true },
  };
  const workspace = {
    source: source(localPath, "head-check"),
    remoteWorkspaceDir: remotePath,
    baseManifestRef: snapshot.manifestRef,
  };
  const actions = workspaceActions({
    environmentId: "environment",
    sessionId: "session",
    supportsGitResults: async () => true,
    restoredWorkspace: { ...workspace, manifestRef: snapshot.manifestRef },
    workspaceTransfer: workspaceTransfer({
      prepareUpload: () => "upload-token",
      takeUpload: () => uploaded,
    }),
    runWorkspaceCommand: async (command) =>
      workspaceCommandResult(remotePath, {
        stdout: command.transfer
          ? snapshot.manifestRef
          : command.argv[0] === "git"
            ? "b".repeat(40)
            : manifestCaptureOutput(snapshot.manifestRef),
      }),
  });
  const result = await actions.reconcileWorkspace(workspace);
  await expect(result.verifyStable()).rejects.toThrow("Git HEAD changed");
  await result.discardPreparedStagedResult?.();
});
