import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "./global-singleton.js";
import { createKeyedFifoLeaseRegistry } from "./keyed-fifo-lease.js";

const TEST_KEY = Symbol.for("openclaw.test.keyedFifoLease");
const reserve = (...keys: string[]) => createKeyedFifoLeaseRegistry(TEST_KEY).reserve(keys)!;

function watch(lease: { wait(): Promise<void> }) {
  const result = { ready: false, promise: Promise.resolve() };
  result.promise = lease.wait().then(() => {
    result.ready = true;
  });
  return result;
}
async function expectBlocked(wait: ReturnType<typeof watch>) {
  await Promise.resolve();
  expect(wait.ready).toBe(false);
}

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_KEY];
});

describe("keyed FIFO leases", () => {
  it("keeps a reserved slot until its idempotent release", async () => {
    const older = reserve("target");
    const middle = reserve("target");
    const newer = reserve("target");
    const newerWait = watch(newer);

    await expectBlocked(newerWait);

    older.release();
    await expectBlocked(newerWait);

    middle.release();
    middle.release();
    await expect(newer.wait()).resolves.toBeUndefined();
    await newerWait.promise;
    expect(newerWait.ready).toBe(true);
    newer.release();
  });

  it("reserves sorted unique multi-key leases without deadlock", async () => {
    const first = reserve("b", "a", "b");
    const second = reserve("a", "b");
    const secondWait = watch(second);

    await expect(first.wait()).resolves.toBeUndefined();
    await expectBlocked(secondWait);
    first.release();
    await secondWait.promise;
    expect(secondWait.ready).toBe(true);
    second.release();
  });

  it("keeps a newer tail when an older tail cleans up", async () => {
    const first = reserve("target");
    first.release();
    const second = reserve("target");
    await expect(second.wait()).resolves.toBeUndefined();
    const third = reserve("target");
    const thirdWait = watch(third);

    await expectBlocked(thirdWait);
    second.release();
    await expect(third.wait()).resolves.toBeUndefined();
    third.release();
  });

  it("releases an idle key independently when a mixed lease exits before its predecessor", async () => {
    const older = reserve("busy");
    const mixed = reserve("idle", "busy");
    const idle = reserve("idle");
    const busy = reserve("busy");
    const busyWait = watch(busy);

    mixed.release();
    await expect(idle.wait()).resolves.toBeUndefined();
    expect(busyWait.ready).toBe(false);
    idle.release();

    older.release();
    await busyWait.promise;
    expect(busyWait.ready).toBe(true);
    busy.release();
  });

  it("shares reservations across duplicate runtime chunks", async () => {
    const moduleA = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-a",
    );
    const moduleB = await importFreshModule<typeof import("./keyed-fifo-lease.js")>(
      import.meta.url,
      "./keyed-fifo-lease.js?scope=duplicate-b",
    );
    const firstRegistry = moduleA.createKeyedFifoLeaseRegistry(TEST_KEY);
    const secondRegistry = moduleB.createKeyedFifoLeaseRegistry(TEST_KEY);
    const first = firstRegistry.reserve(["target"])!;
    const second = secondRegistry.reserve(["target"])!;
    const secondWait = watch(second);

    await expectBlocked(secondWait);
    first.release();
    await expect(second.wait()).resolves.toBeUndefined();
    second.release();
  });

  it("releases live gates on full close but not restart", async () => {
    const registry = createKeyedFifoLeaseRegistry(TEST_KEY);
    registry.reserve(["target"]);
    registry.reserve(["target"]);
    const last = registry.reserve(["target"])!;
    const lastWait = watch(last);

    await drainGlobalSingletonLifecycleState("restart");
    await expectBlocked(lastWait);

    await drainGlobalSingletonLifecycleState("close");
    await expect(lastWait.promise).resolves.toBeUndefined();

    const fresh = registry.reserve(["target"])!;
    await expect(fresh.wait()).resolves.toBeUndefined();
    fresh.release();
  });
});
