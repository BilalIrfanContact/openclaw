import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeatEvent,
  emitLegacyHeartbeatCronOutcome,
  getLastHeartbeatEvent,
  heartbeatNotifications,
  resetHeartbeatEventsForTest,
} from "./heartbeat-events.js";

type HeartbeatEventsModule = typeof import("./heartbeat-events.js");

async function importHeartbeatEventsModule(cacheBust: string): Promise<HeartbeatEventsModule> {
  return (await import(
    `${new URL("./heartbeat-events.ts", import.meta.url).href}?t=${cacheBust}`
  )) as HeartbeatEventsModule;
}

describe("heartbeat events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));
  });

  afterEach(() => {
    resetHeartbeatEventsForTest();
    vi.useRealTimers();
  });

  it.each([
    ["ok", "succeeded", true, "sent"],
    ["ok", "succeeded", false, "ok-empty"],
    ["error", "failed", false, "failed"],
    ["ok", "unknown", false, "skipped"],
  ] as const)(
    "projects receipt settlement (%s, %s, delivered: %s) into %s",
    (status, completionStatus, delivered, expected) => {
      emitLegacyHeartbeatCronOutcome({
        jobId: "converted",
        action: "finished",
        status,
        completionStatus,
        delivered,
        summary: "Synthetic automation result",
        durationMs: 12,
      });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: expected,
        preview: "Synthetic automation result",
        durationMs: 12,
        silent: !delivered,
      });
    },
  );

  it.each([
    ["target-none", undefined, "Heartbeat delivery is disabled by configuration (target: none)."],
    ["target-none", "custom diagnostic", "custom diagnostic"],
    [
      "no-route",
      undefined,
      "Heartbeat has no delivery route yet. Message your bot once, or set agents.defaults.heartbeat.target.",
    ],
  ])(
    "enriches %s events while preserving explicit messages (%s)",
    (reason, message, expectedMessage) => {
      const listener = vi.fn();
      heartbeatNotifications.onEvent = listener;
      emitHeartbeatEvent({ status: "skipped", reason, ...(message ? { message } : {}) });
      const expected = {
        ts: 1767960000000,
        status: "skipped",
        reason,
        message: expectedMessage,
      };
      expect(getLastHeartbeatEvent()).toEqual(expected);
      expect(listener).toHaveBeenCalledWith(expected);
    },
  );

  it.each([
    [`${"s".repeat(1999)}\u{1F600}summary tail`, "s".repeat(1999)],
    [`${"s".repeat(1998)}\u{1F600}`, `${"s".repeat(1998)}\u{1F600}`],
  ])("preserves whole code points at the preview cap", (summary, expected) => {
    emitLegacyHeartbeatCronOutcome({
      jobId: "converted",
      action: "finished",
      status: "ok",
      completionStatus: "succeeded",
      delivered: true,
      summary,
    });
    expect(getLastHeartbeatEvent()?.preview).toBe(expected);
  });

  it("delivers events to the Gateway callback and isolates its failures", () => {
    const seen: string[] = [];
    heartbeatNotifications.onEvent = () => {
      throw new Error("boom");
    };
    expect(() => emitHeartbeatEvent({ status: "failed" })).not.toThrow();
    expect(getLastHeartbeatEvent()?.status).toBe("failed");

    heartbeatNotifications.onEvent = (evt) => {
      seen.push(evt.status);
    };
    emitHeartbeatEvent({ status: "ok-empty" });
    heartbeatNotifications.onEvent = () => {};
    emitHeartbeatEvent({ status: "failed" });

    expect(seen).toEqual(["ok-empty"]);
  });

  it("shares heartbeat state across duplicate module instances", async () => {
    const first = await importHeartbeatEventsModule(`first-${Date.now()}`);
    const second = await importHeartbeatEventsModule(`second-${Date.now()}`);

    first.resetHeartbeatEventsForTest();

    const seen: string[] = [];
    first.heartbeatNotifications.onEvent = (evt) => {
      seen.push(evt.status);
    };

    second.emitHeartbeatEvent({ status: "ok-token", preview: "pong" });

    expect(first.getLastHeartbeatEvent()).toEqual({
      ts: 1767960000000,
      status: "ok-token",
      preview: "pong",
    });
    expect(seen).toEqual(["ok-token"]);
  });
});
