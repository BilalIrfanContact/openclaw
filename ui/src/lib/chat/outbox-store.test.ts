/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import { outboxStorageScope } from "./outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type { StoredComposerState } from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader } from "./outbox-store-projection.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import {
  readStoredOutboxStore,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

function ownedState(gatewayUrl = target.gatewayOwner) {
  return {
    settings: { gatewayUrl },
    client: { recoveryScope: "summary-owner", recoveryScopeReady: true },
    connected: true,
  };
}

function ownedQueue(gatewayUrl: string, queue: ChatQueueItem[]): ChatQueueItem[] {
  return queue.map((item) => ({
    ...item,
    storageScope: outboxStorageScope(ownedState(gatewayUrl)),
  }));
}

const queued = (id: string, overrides: Partial<ChatQueueItem> = {}): ChatQueueItem => ({
  id,
  text: id,
  createdAt: 1,
  ...overrides,
});
const storedSession = (overrides: Partial<StoredComposerState["sessions"][string]> = {}) => ({
  updatedAt: 1,
  ...overrides,
});
const draftSession = (draft: string, revision: number) =>
  storedSession({ draft, draftRevision: revision, updatedAt: revision });
const privateInput = () => ({
  draft: "@Alex private legacy input",
  draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
  goalMode: { action: "start", sessionId: "private-goal" },
});
const readStore = () => readStoredOutboxStore(sessionStorage, target);
const storedJson = (key: string) => JSON.parse(sessionStorage.getItem(key)!);

function seedStore(
  target: ReturnType<typeof storageTargetForGateway>,
  sessions: StoredComposerState["sessions"],
  recovery: StoredComposerState["recovery"] = {},
) {
  const store = { version: 4, gatewayOwner: target.gatewayOwner, sessions, recovery };
  sessionStorage.setItem(target.key, JSON.stringify(store));
  return store;
}

function seedSource(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  const key = [target.legacyKey, target.previousKey, target.blobKey, target.key][version - 1]!;
  const source = sourceJson(target, version, sessions);
  sessionStorage.setItem(key, source);
  return { key, source };
}

function sourceJson(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  return JSON.stringify({
    version,
    ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
    ...(version === 4 ? { recovery: {} } : {}),
    sessions,
  });
}

const recoveryRow = (
  sourceScopeKey: string,
  session: StoredComposerState["sessions"][string],
  sourceVersion: 1 | 2 | 3 | 4 = 4,
) => ({ sourceVersion, sourceScopeKey, session });
const recoveryRows = (make: (index: number) => ReturnType<typeof recoveryRow>) =>
  Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`row-${index}`, make(index)]));
const mention = (start = 0, end = 5) => ({ profileId: "profile-alex", start, end });
function storageEvent(key: string | null) {
  const event = new StorageEvent("storage", { key });
  Object.defineProperty(event, "storageArea", { value: sessionStorage });
  window.dispatchEvent(event);
}

const badge = (
  sessionKey: string,
  agentId: string | undefined,
  hasComposerDraft: boolean,
  outboxAttentionCount = 0,
) => ({ agentId, sessionKey, hasComposerDraft, outboxAttentionCount });
const gatewayUrl = "ws://gateway.test/control";
const target = storageTargetForGateway(gatewayUrl);
const privateScope = "agent:main:dashboard:incognito-test\u0000agent:main";
const quotaExceeded = () => {
  throw new DOMException("quota exceeded", "QuotaExceededError");
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["raw", "cleared"])("preserves newer legacy bytes during %s retirement", (input) => {
  const scopeKey = privateScope;
  const source = (id: string) =>
    sourceJson(target, 3, {
      [scopeKey]: storedSession({ draft: "Private legacy input", queue: [queued(id)] }),
    });
  sessionStorage.setItem(target.blobKey, source("submitted"));
  if (input === "cleared") {
    const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
    readStore();
    expect(sessionStorage.getItem(target.blobKey)).toBe("");
    removal.mockRestore();
  }
  const replacement = source("newer-submission");
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
    if (key === target.blobKey) {
      sessionStorage.setItem(key, replacement);
      throw new Error("Source changed during removal");
    }
    remove(key);
  });
  const migrated = readStore();
  expect(sessionStorage.getItem(target.blobKey)).toBe(replacement);
  expect(migrated.sessions[scopeKey]?.queue).toMatchObject([{ id: "submitted" }]);
});

it.each([1, 3])("retires v%i private input after failed deletion without replay", (version) => {
  const scopeKey = privateScope;
  const { key: sourceKey, source } = seedSource(target, version, {
    [scopeKey]: {
      ...privateInput(),
      queue: [queued("submitted", { text: "Submitted message" })],
      updatedAt: 1,
    },
    "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
  });
  const blocked = { removal: true, writes: true };
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  const write = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
    if (key === sourceKey && blocked.removal) {
      throw new Error("Source deletion unavailable");
    }
    remove(key);
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    if (key === sourceKey && blocked.writes) {
      throw new Error("Source writes unavailable");
    }
    write(key, value);
  });
  const migrated = readStore();
  expect(sessionStorage.getItem(sourceKey)).toBe(source);
  expect(migrated.sessions[scopeKey]?.queue).toMatchObject([
    { id: "submitted", text: "Submitted message" },
  ]);
  expect(Object.values(migrated.recovery)[0]?.session.draft).toBe("Ambiguous input");
  blocked.writes = false;
  expect(readStore()).toEqual(migrated);
  const retained = sessionStorage.getItem(sourceKey) ?? "";
  for (const privateValue of ["private legacy input", "profileId", "private-goal"]) {
    expect(retained).not.toContain(privateValue);
  }
  expect(readStore()).toEqual(migrated);
  blocked.removal = false;
  expect(readStore()).toEqual(migrated);
  expect(sessionStorage.getItem(sourceKey)).toBeNull();
});

it.each([1, 3])(
  "retires v%i deferred private input, preserving queues and ambiguity",
  (version) => {
    const scopeKey = privateScope;
    const item = queued("submitted", { text: "Submitted private message" });
    const privateRow = {
      ...privateInput(),
      draftRevision: 7,
      queue: [item],
      updatedAt: 1,
      unknownMetadata: "preserve",
    };
    const sessions = {
      [scopeKey]: privateRow,
      "agent:main:dashboard:incognito-draft-only\u0000agent:main": {
        draft: "Private draft without an explicit revision",
        updatedAt: 2,
      },
      "agent:main:dashboard:incognito-goal-only\u0000agent:main": {
        goalMode: { action: "start", sessionId: "private-goal" },
        updatedAt: 3,
      },
      "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
    };
    const { key: sourceKey, source } = seedSource(target, version, sessions);
    const store = seedStore(
      target,
      {},
      recoveryRows((index) =>
        recoveryRow("main\u0000agent:main", storedSession({ draft: `Existing ${index}` })),
      ),
    );
    expect(readStore().recoveryBlocked).toBe(true);
    const retained = storedJson(sourceKey);
    const { draft: _draft, draftMentions: _mentions, goalMode: _goal, ...preserved } = privateRow;
    expect(retained).toEqual({
      ...JSON.parse(source),
      sessions: {
        [scopeKey]: preserved,
        "main\u0000agent:main": sessions["main\u0000agent:main"],
      },
    });
    expect(storedJson(target.key)).toEqual(store);
    expect(storedJson(sourceKey)).toEqual(retained);
    sessionStorage.setItem(target.key, JSON.stringify({ ...store, recovery: {} }));
    const remove = sessionStorage.removeItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
      if (key !== sourceKey) {
        remove(key);
      }
    });
    const migrated = readStore();
    expect(Object.values(migrated.recovery).flatMap((entry) => entry.session.queue ?? [])).toEqual([
      item,
    ]);
    expect(Object.values(migrated.recovery)).toHaveLength(2);
    expect(sessionStorage.getItem(sourceKey)).not.toBeNull();
    expect(readStore()).toEqual(migrated);
  },
);

it("admits legacy input through full clear fences without replay", () => {
  const state = ownedState(target.gatewayOwner);
  const scopeKey = "global\u0000agent:main";
  const fence = { draftRevision: 100, updatedAt: 100 };
  seedStore(
    target,
    { [scopeKey]: fence },
    recoveryRows((index) =>
      recoveryRow(
        "old-" + index + "\u0000agent:main",
        { draftRevision: index + 1, updatedAt: index + 1 },
        3,
      ),
    ),
  );
  const source = sourceJson(target, 3, {
    [scopeKey]: draftSession("real saved input", 101),
    "main\u0000agent:main": { draftRevision: 99, updatedAt: 99 },
  });
  sessionStorage.setItem(target.blobKey, source);
  const recovery = readChatOutboxRecovery(state);
  expect(recovery.blocked).toBe(false);
  expect(recovery.entries.map((entry) => entry.session.draft)).toEqual(["real saved input"]);
  expect(Object.keys(readStore().recovery)).toHaveLength(1);
  expect(readStore().sessions[scopeKey]).toEqual(fence);
  expect(discardChatOutboxRecovery(state, recovery.entries[0]!)).toBe("discarded");
  // A failed old-source deletion or downgraded writer cannot replay acknowledged bytes.
  sessionStorage.setItem(target.blobKey, source);
  expect(readChatOutboxRecovery(state)).toEqual({ entries: [], blocked: false });
  expect(readStore().sessions[scopeKey]).toEqual(fence);
});

it("retires private recovery and rejects pre-roster private destinations", () => {
  const sessionKey = "agent:main:dashboard:incognito-recovery";
  const scopeKey = storedChatOutboxScopeKey({ sessionKey });
  seedStore(
    target,
    {},
    {
      legacy: recoveryRow(scopeKey, {
        draft: "private recovery input",
        draftRevision: 4,
        updatedAt: 1,
        queue: [{ id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" }],
      }),
    },
  );
  const state = {
    settings: { gatewayUrl: target.gatewayOwner },
    agentsList: { defaultId: "main", mainKey: "main" },
  };
  const entries = readChatOutboxRecovery(state).entries;
  expect(entries[0]?.session).toEqual({
    draftRevision: 4,
    updatedAt: 1,
    queue: [{ id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" }],
  });
  expect(sessionStorage.getItem(target.key)).not.toContain("private recovery input");
  expect(captureChatOutboxRecoveryDestination(state, { sessionKey })).toBeNull();
});

it.each([
  ["valid", undefined],
  ["out of range", [mention(0, 50)]],
  ["missing prefix", [mention(1)]],
  ["malformed", "profile-alex"],
] as const)("restores valid mentions and parks invalid metadata: %s", (_reason, invalid) => {
  const scopeKey = storedChatOutboxScopeKey({ sessionKey: "agent:main:mentions" });
  const mentions = [mention()];
  const item = queued(invalid === undefined ? "mention-send" : "corrupt-mention", {
    text: invalid === undefined ? "@Alex queued" : "@Alex review",
    sendState: "waiting-reconnect",
  });
  if (invalid === undefined) {
    const store = readStore();
    store.sessions[scopeKey] = storedSession({
      draft: "@Alex draft",
      draftMentions: mentions,
      queue: [{ ...item, mentions, sendRunId: "mention-run" }],
    });
    writeStoredOutboxStore(sessionStorage, target, store);
    mentions[0]!.profileId = "later-selection";
  } else {
    seedSource(target, 4, {
      [scopeKey]: { updatedAt: 1, queue: [{ ...item, mentions: invalid }] },
    });
  }
  const restored = readStore().sessions[scopeKey];
  if (invalid === undefined) {
    expect(restored).toMatchObject({
      draft: "@Alex draft",
      draftMentions: [mention()],
      queue: [
        {
          text: "@Alex queued",
          mentions: [mention()],
          sendRunId: "mention-run",
          sendState: "waiting-reconnect",
        },
      ],
    });
  } else {
    expect(restored?.queue?.[0]).toMatchObject({ text: "@Alex review", sendState: "failed" });
    expect(restored?.queue?.[0]?.mentions).toBeUndefined();
    expect(restored?.queue?.[0]?.sendError).toBeTruthy();
  }
});

it.each([1, 2, 4])("refreshes a cached v%i projection after an external write", (version) => {
  const reader = createStoredChatOutboxReader();
  const changed = vi.fn();
  cleanups.push(reader.subscribe(changed));
  const state = { settings: { gatewayUrl }, client: null, connected: false };
  const { key } = seedSource(target, version, {
    "agent:main:summary\u0000agent:main": storedSession({ queue: [queued("first")] }),
  });
  if (version !== 4) {
    const write = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementation((nextKey, value) => {
      if (nextKey !== key) {
        quotaExceeded();
      }
      write(nextKey, value);
    });
  }
  expect(reader.read(state)).toMatchObject({ total: 1 });
  expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(false);
  seedSource(target, version, {
    "agent:main:summary\u0000agent:main": storedSession({
      draft: "new",
      queue: [queued("first"), queued("second")],
    }),
  });
  storageEvent(key);
  expect(reader.read(state).total).toBe(2);
  const cached = reader.read(state);
  reader.invalidate();
  expect(reader.read(state)).not.toBe(cached);
  expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  expect(reader.read(ownedState(gatewayUrl)).total).toBe(0);
  expect(reader.read({ ...state, settings: { gatewayUrl: "ws://other.test" } }).total).toBe(0);
  expect(reader.read(state).total).toBe(2);
});

it.each([1, 3])("retains the last v%i source when quota blocks verified retirement", (version) => {
  const scopeKey = storedChatOutboxScopeKey({ sessionKey: "thread", agentId: "main" });
  const { key: sourceKey } = seedSource(target, version, {
    [scopeKey]: storedSession({ queue: [queued("queued", { text: "retire me" })] }),
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation(quotaExceeded);
  const store = readStore();
  expect(store.sessions[scopeKey]?.queue).toHaveLength(1);
  store.sessions = {};
  expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow("quota exceeded");
  expect(readStore().sessions[scopeKey]?.queue).toEqual([
    { id: "queued", text: "retire me", createdAt: 1, sessionKey: "thread" },
  ]);
  expect(sessionStorage.getItem(sourceKey)).toContain("retire me");
});

it("clears every retained projection after an external storage clear", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeStoredChatOutboxChanges(listener);
  const gatewayUrls = ["ws://first.test/control", "ws://second.test/control"];
  for (const storageGateway of gatewayUrls) {
    seedStore(storageTargetForGateway(storageGateway, "summary-owner"), {
      "thread\u0000agent:main": storedSession({
        queue: ownedQueue(storageGateway, [queued(storageGateway)]),
      }),
    });
    expect(createStoredChatOutboxReader().read(ownedState(storageGateway)).total).toBe(1);
  }
  sessionStorage.clear();
  storageEvent(null);
  unsubscribe();
  for (const storageGateway of gatewayUrls) {
    expect(createStoredChatOutboxReader().read(ownedState(storageGateway)).total).toBe(0);
  }
  expect(listener).toHaveBeenCalledOnce();
});

it.each([
  ["agent:main:main", "agent:main:current", 11, false, false],
  ["global", "newer", 1_000, true, false],
  ["older", "newer", 1_000, false, true],
] as const)(
  "retires captured %s while preserving other drafts",
  (oldKey, otherKey, revision, failed, batch) => {
    const agentId = failed ? "work" : "main";
    const scope = storedChatOutboxScopeKey({ sessionKey: oldKey, agentId });
    const other = storedChatOutboxScopeKey({ sessionKey: otherKey });
    const replacement = draftSession("replacement", revision);
    seedStore(target, {
      [scope]: {
        ...draftSession("retire me", 10),
        ...(revision === 11 ? {} : { queue: [queued("queued")] }),
      },
      ...(failed ? {} : { [other]: replacement }),
    });
    const before = sessionStorage.getItem(target.key);
    if (failed) {
      vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(quotaExceeded);
    }
    const listener = vi.fn();
    cleanups.push(subscribeStoredChatOutboxChanges(listener));
    const cutoff = batch ? 100 : 20;
    const result = retireStoredComposerDrafts(
      {
        settings: { gatewayUrl: target.gatewayOwner },
        agentsList: { defaultId: "main", mainKey: "current", scope: "per-sender" },
      },
      [
        { key: oldKey, agentId, retireBeforeRevision: cutoff },
        ...(batch ? [{ key: otherKey, agentId: "main", retireBeforeRevision: cutoff }] : []),
      ],
    );
    expect(result.storageFailed).toBe(failed);
    expect(result.retirements[0]).toEqual({
      scope: { sessionKey: oldKey, agentId },
      minimumRevision: expect.any(Number),
      retireBeforeRevision: cutoff,
    });
    if (failed) {
      expect(sessionStorage.getItem(target.key)).toBe(before);
    } else {
      const stored = readStore().sessions;
      expect(stored[scope]).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(stored[scope]?.draftRevision).toBeGreaterThan(cutoff);
      expect(stored[other]).toEqual(replacement);
      expect(listener).toHaveBeenCalledOnce();
    }
  },
);

it("queries unresolved main drafts before defaults arrive", () => {
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    "main\u0000agent:@unresolved": draftSession("pending draft", 3),
  });
  const summary = createStoredChatOutboxReader().read({ ...ownedState(gatewayUrl), hello: null });
  expect(summary.hasSessionDraft("main")).toBe(true);
  expect(summary.hasSessionDraft("agent:main:main")).toBe(false);
});

it("bridges matching storage events until the last subscriber leaves", () => {
  const first = vi.fn(),
    second = vi.fn();
  const offFirst = subscribeStoredChatOutboxChanges(first);
  const offSecond = subscribeStoredChatOutboxChanges(second);
  storageEvent("openclaw.control.settings.v1");
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 0]);
  storageEvent(target.key);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
  offFirst();
  storageEvent(target.legacyKey);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
  offSecond();
  storageEvent(target.key);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
});

it("rejects a store owned by another gateway", () => {
  seedStore(
    { ...target, gatewayOwner: "ws://other.test/control" },
    {
      "global\u0000agent:work": storedSession({ queue: [queued("queued")] }),
    },
  );
  expect(
    createStoredChatOutboxReader().read({
      client: null,
      connected: false,
      settings: { gatewayUrl },
      agentsList: { defaultId: "work", mainKey: "workspace" },
    }).total,
  ).toBe(0);
  expect(storedJson(target.key).gatewayOwner).toBe("ws://other.test/control");
});

it("projects metadata-only badges and counts distinct operator-review rows", () => {
  const queue = [
    ...(
      [undefined, "waiting-idle", "executing-command", "sending", "waiting-reconnect"] as const
    ).map((sendState, index) => queued("healthy-" + index, { sendState })),
    queued("held", { sendState: "held" }),
    ...(["failed", "waiting-reconnect"] as const).flatMap((sendState) =>
      [1, 2].map(() => queued(sendState, { sendState })),
    ),
    queued("other-owner", {
      sendState: "failed",
      attachmentPayload: { key: "bundle", recoveryScope: "other-owner", tabId: "tab" },
    }),
  ];
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    "agent:main:a\u0000agent:main": storedSession({ draft: "private draft" }),
    "thread-empty\u0000agent:main": storedSession({ draftRevision: 1 }),
    "agent:work:b\u0000agent:work": storedSession({ queue: ownedQueue(gatewayUrl, queue) }),
    "thread-b\u0000agent:main": storedSession({
      queue: ownedQueue(gatewayUrl, [
        queued("waiting-reconnect", { sendState: "waiting-reconnect" }),
      ]),
    }),
  });
  const summary = createStoredChatOutboxReader().read(ownedState(gatewayUrl));
  const read = vi.spyOn(sessionStorage, "getItem");
  sessionStorage.clear();
  expect(summary.total).toBe(9);
  expect(summary.sessions).toEqual([
    badge("agent:main:a", "main", true),
    badge("agent:work:b", "work", false, 3),
  ]);
  expect(summary.attentionCountForSession("agent:work:b")).toBe(3);
  expect(summary.attentionCountForSession("thread-b")).toBe(0);
  expect(summary.attentionCountForSession("absent")).toBe(0);
  expect(summary.hasSessionDraft("agent:main:a")).toBe(true);
  expect(summary.hasSessionDraft("agent:work:b")).toBe(false);
  expect(summary.hasSessionDraft("thread-empty")).toBe(false);
  expect(summary.hasSessionDraft("absent")).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it("filters legacy queue tombstones before offering recovery", () => {
  seedSource(target, 1, {
    "main\u0000agent:previous": {
      queue: [queued("removed"), queued("shared", { text: "older", createdAt: 2 })],
      removedQueueItemIds: ["removed"],
      updatedAt: 2,
    },
  });
  const recovery = readChatOutboxRecovery(ownedState());
  expect(recovery.entries).toHaveLength(1);
  expect(recovery.entries[0]?.session.queue).toEqual([
    queued("shared", { text: "older", createdAt: 2 }),
  ]);
  expect(sessionStorage.getItem(target.legacyKey)).toBeNull();
});
