import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const readRegistryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ entries: Array<{ backendId?: string }> }> => ({ entries: [] })),
);
const tempDirs = createTempDirTracker();

vi.mock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

// mock-isolation: CLI startup controls sandbox entries without reading persisted SQLite state.
vi.mock("../agents/sandbox/registry.js", () => ({ readRegistry: readRegistryMock }));

let originalForceStderr: boolean;
let ensureCliPluginRegistryLoaded: typeof import("./plugin-registry-loader.js").ensureCliPluginRegistryLoaded;
let loggingState: typeof import("../logging/state.js").loggingState;

beforeAll(async () => {
  ({ ensureCliPluginRegistryLoaded } = await import("./plugin-registry-loader.js"));
  ({ loggingState } = await import("../logging/state.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  readRegistryMock.mockResolvedValue({ entries: [] });
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
});

afterEach(() => {
  flushDiagnosticsTimeline();
  tempDirs.cleanup();
  loggingState.forceConsoleToStderr = originalForceStderr;
  vi.unstubAllEnvs();
});

it.each([
  [false, 0, false, true],
  [false, 1, true, true],
  [true, 0, false, true],
  [false, 0, false, false],
] as const)(
  "restores stderr=%s (first=%s, reject=%s, routeSecond=%s)",
  async (initial, finishFirst, reject, routeSecond) => {
    loggingState.forceConsoleToStderr = initial;
    const started = Promise.withResolvers<void>();
    const resume = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const captured: boolean[] = [];
    const failure = new Error("Plugin activation failed");
    resume.forEach((gate, id) => {
      ensurePluginRegistryLoadedMock.mockImplementationOnce(async () => {
        if (id === 1) {
          started.resolve();
        }
        await gate.promise;
        captured.push(loggingState.forceConsoleToStderr);
        if (reject && id === finishFirst) {
          throw failure;
        }
      });
    });
    const start = (routeLogsToStderr: boolean) =>
      ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr }).then(
        () => undefined,
        (error: unknown) => error,
      );
    const pending = [start(true), start(routeSecond)] as const;
    const finishLast = finishFirst === 0 ? 1 : 0;
    try {
      await started.promise;
      expect(loggingState.forceConsoleToStderr).toBe(true);
      resume[finishFirst].resolve();
      expect(await pending[finishFirst]).toBe(reject ? failure : undefined);
      expect(loggingState.forceConsoleToStderr).toBe(routeSecond || finishFirst === 1);
      resume[finishLast].resolve();
      expect(await pending[finishLast]).toBeUndefined();
      expect(captured).toEqual([true, routeSecond]);
      expect(loggingState.forceConsoleToStderr).toBe(initial);
    } finally {
      resume.forEach((gate) => gate.resolve());
      await Promise.all(pending);
    }
  },
);

it("forwards explicit config snapshots to plugin loading", async () => {
  const params = {
    scope: "configured-channels" as const,
    config: { channels: { quietchat: { enabled: true } } },
  };
  await ensureCliPluginRegistryLoaded(params);
  expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith(params);
});

it("includes persisted runtime owners when loading sandbox managers", async () => {
  readRegistryMock.mockResolvedValue({
    entries: [{ backendId: "openshell" }, { backendId: "docker" }, { backendId: "openshell" }],
  });

  await ensureCliPluginRegistryLoaded({ scope: "sandbox-management" });

  expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
    scope: "sandbox-backends",
    persistedSandboxBackendIds: ["docker", "openshell"],
  });
});

it("attributes module import separately from runtime loading", async () => {
  const timelinePath = join(tempDirs.make("openclaw-plugin-registry-startup-"), "timeline.jsonl");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);

  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({ scope: "all" }),
  );

  flushDiagnosticsTimeline();
  const events = (await readFile(timelinePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const starts = events.filter((event) => event.type === "span.start");
  const outer = starts.find(
    (event) => (event.attributes as { stage?: string } | undefined)?.stage === "plugin-registry",
  );
  expect(outer).toBeDefined();
  expect(
    starts
      .filter((event) => event.parentSpanId === outer?.spanId)
      .map((event) => (event.attributes as { stage?: string } | undefined)?.stage),
  ).toEqual(["plugin-registry-module-import", "plugin-registry-runtime-load"]);
});
