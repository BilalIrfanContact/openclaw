import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { createCliLiveSessionCapability } from "../agents/cli-runner/cli-live-session-registry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { CliBackendLiveSessionHandle } from "../plugins/cli-backend.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";

type GatewayCloseHandler = ReturnType<ReturnType<typeof createGatewayCloseTestHandlerFactory>>;

export function registerGatewayResourceRetirementTests(
  createGatewayCloseHandler: (overrides?: Partial<GatewayCloseParams>) => GatewayCloseHandler,
): void {
  it("retires warm CLI processes and joins their resource cleanup during shutdown", async () => {
    const context = buildPreparedCliRunContext({ sessionId: "shutdown-warm-cli" });
    const admission = prepareSystemAgentRunAdmission(
      {},
      context.params.runId,
      "main",
      "shutdown-test",
    );
    context.params.admittedRunContext = await admission.admit("plugin-harness");
    const child = spawn(process.execPath, [
      "-e",
      "process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ]);
    const exited = once(child, "close").then(() => undefined);
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const capability = createCliLiveSessionCapability({
      context,
      argv: [process.execPath],
      env: {},
      beginCapture() {},
      abortSignal: new AbortController().signal,
      claimResources: () => async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      },
    });
    const handle: CliBackendLiveSessionHandle = {
      generation: "shutdown-warm-cli",
      fingerprint: capability.fingerprint,
      isIdle: () => true,
      close: () => {
        capability.remove(handle);
        child.kill("SIGTERM");
      },
      waitForExit: () => exited,
    };
    let closing: Promise<unknown> | undefined;
    try {
      await once(child.stdout!, "data");
      capability.register(handle);
      admission.close();
      closing = createGatewayCloseHandler()({ reason: "warm CLI shutdown" });
      await awaitGateBeforeSettlement(
        cleanupEntered.promise,
        closing,
        "Gateway closed without retiring its warm CLI process",
      );
      expect(isProcessAlive(child.pid!)).toBe(false);
      const settled = vi.fn();
      void closing.then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      releaseCleanup.resolve();
      await closing;
    } finally {
      handle.close("abort");
      releaseCleanup.resolve();
      await exited;
      await closing;
      admission.close();
    }
  });

  it("keeps incognito memory alive when a non-final Gateway closes", async () => {
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: "/synthetic/gateway-close/incognito-openclaw-agent.sqlite",
    });
    const sessionKey = "agent:main:dashboard:incognito-close";
    const authority = { assertCurrent() {}, authorize() {} };
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    const created = await actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId: "private-session", updatedAt: 1, incognito: true } },
      },
      authority,
    );
    expect(created.kind).toBe("committed");
    try {
      await createGatewayCloseHandler({
        pluginMetadata: {
          beginClose() {},
          async close(_onFinal, retireRegistry) {
            return (await retireRegistry?.()) ?? { cleanupCount: 0, failures: [] };
          },
        },
      })();
      expect(actor.snapshot(authority)?.entry?.sessionId).toBe("private-session");
    } finally {
      await createGatewayCloseHandler()();
      await actor.release();
    }
  });
}
