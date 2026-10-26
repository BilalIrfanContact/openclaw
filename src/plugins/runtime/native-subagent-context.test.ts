import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  nativeSubagentRuntime,
  withNativeSubagentRequest,
  withNativeSubagentRuntimeGuard,
} from "./native-subagent-context.js";
import type { NativeSubagentRuntime } from "./types-native-subagent.js";

function fixture() {
  const spawn = vi.fn<NativeSubagentRuntime["spawn"]>().mockResolvedValue({
    runId: "child-run",
    childSessionKey: "agent:main:subagent:child",
    completionMode: "collect",
  });
  const collect = vi
    .fn<NativeSubagentRuntime["collect"]>()
    .mockResolvedValue({ completed: [], pending: ["child-run"] });
  return { spawn, collect };
}
const params = { requestId: "first", task: "Review the change" };
const guard = { pluginId: "test-plugin", assertCurrent() {} };
const inRequest = <T>(
  create: Parameters<typeof withNativeSubagentRequest>[0],
  run: () => Promise<T>,
) => withNativeSubagentRequest(create, () => withNativeSubagentRuntimeGuard(guard, run));
const listChildren = (options?: Parameters<NonNullable<NativeSubagentRuntime["list"]>>[0]) =>
  expectDefined(nativeSubagentRuntime.list, "list facade")(options);

describe("native subagent requester binding", () => {
  it("rejects calls without both a host request and a plugin runtime", async () => {
    await expect(nativeSubagentRuntime.spawn(params)).rejects.toThrow("requester-bound");
    const runtime = fixture();
    await withNativeSubagentRequest(
      () => runtime,
      () => expect(nativeSubagentRuntime.spawn(params)).rejects.toThrow("requester-bound"),
    );
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it.each(["request", "plugin"] as const)(
    "keeps identical calls in separate %s bindings",
    async (boundary) => {
      const ready = createDeferred();
      const runtimes = [fixture(), fixture()];
      const invoke = (index: number) =>
        withNativeSubagentRuntimeGuard(
          { ...guard, pluginId: boundary === "plugin" ? String(index) : guard.pluginId },
          async () => {
            await (index === 0 ? ready.promise : ready.resolve());
            await nativeSubagentRuntime.spawn(params);
          },
        );
      if (boundary === "request") {
        await Promise.all(
          runtimes.map((runtime, index) =>
            withNativeSubagentRequest(
              () => runtime,
              () => invoke(index),
            ),
          ),
        );
      } else {
        await withNativeSubagentRequest(
          (source) => expectDefined(runtimes[Number(source.pluginId)], "plugin runtime fixture"),
          () => Promise.all([invoke(0), invoke(1)]),
        );
      }
      for (const runtime of runtimes) {
        expect(runtime.spawn).toHaveBeenCalledExactlyOnceWith(params);
      }
    },
  );

  it("reports optional listing absence honestly on an older runtime", async () => {
    await inRequest(fixture, () =>
      expect(listChildren()).rejects.toThrow("listing is unsupported"),
    );
  });

  it("expires retained listing calls with their invoking request", async () => {
    const list = vi.fn<NonNullable<NativeSubagentRuntime["list"]>>().mockResolvedValue([]);
    const gate = createDeferred();
    let detached: Promise<unknown> | undefined;
    await inRequest(
      () => ({ ...fixture(), list }),
      async () => {
        expect(await listChildren({ status: "queued" })).toEqual([]);
        detached = gate.promise.then(() => listChildren());
      },
    );
    gate.resolve();
    await expect(detached).rejects.toThrow("requester-bound");
    expect(list).toHaveBeenCalledExactlyOnceWith({ status: "queued" });
  });

  it("aborts the request scope after a handler exits", async () => {
    let signal: AbortSignal | undefined;
    await inRequest(
      (source) => {
        signal = source.signal;
        return fixture();
      },
      async () => {
        await nativeSubagentRuntime.collect({ ids: ["child-run"], timeoutSeconds: 0 });
      },
    );
    expect(signal?.aborted).toBe(true);
  });
});
