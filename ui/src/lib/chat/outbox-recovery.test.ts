/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import * as payloadStore from "./outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  retireDeliveredChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type { StoredComposerRecovery, StoredComposerSession } from "./outbox-store-codec.ts";
import {
  readStoredOutboxStore,
  storageTargetForComposer,
  storageTargetForGateway,
  storedChatOutboxScopeKey as scopeKey,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

const gatewayUrl = "wss://transfer.test";
const sourceScope = "agent:main:legacy\u0000agent:main";
const firstScope = { sessionKey: "agent:main:first", agentId: "main" };
const secondScope = { sessionKey: "agent:main:second", agentId: "main" };
const attachment = { id: "file", mimeType: "text/plain", fileName: "saved.txt" };
const storageScope = JSON.stringify([gatewayUrl, "account-a"]);
const deliveredMessage = (idempotencyKey = "original-attempt", local = false) => ({
  role: "user",
  content: "Retained queue 雪",
  __openclaw: { id: local ? null : "delivered", seq: null, idempotencyKey },
});
const storedSession = (input: Omit<StoredComposerSession, "updatedAt">, updatedAt = 1) => ({
  ...input,
  updatedAt,
});
const queueItem = (overrides: Partial<ChatQueueItem> = {}): ChatQueueItem => ({
  id: "original-input",
  text: "Retained queue 雪",
  createdAt: 1,
  ...overrides,
});
const submittedItem = () =>
  queueItem({
    sendRunId: "original-attempt",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    sessionId: "original-session",
  });
const recovery = (
  session: StoredComposerSession,
  sourceVersion: StoredComposerRecovery["sourceVersion"] = 4,
): StoredComposerRecovery => ({
  sourceVersion,
  sourceScopeKey: sourceScope,
  session,
});
function fixture(kind: "queue" | "draft", sibling = false, originalScope = sourceScope) {
  const state = {
    settings: { gatewayUrl },
    connected: true,
    client: { recoveryScope: "account-a", recoveryScopeReady: true },
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    sessionKey: firstScope.sessionKey,
    chatMessage: "",
    chatQueue: [],
  };
  const session = storedSession({
    draftRevision: 1,
    ...(kind === "draft" ? { draft: "Retained draft 雪" } : { queue: [submittedItem()] }),
  });
  const source = storageTargetForGateway(gatewayUrl);
  sessionStorage.setItem(
    source.key,
    JSON.stringify({
      version: 4,
      gatewayOwner: gatewayUrl,
      recovery: {},
      sessions: {
        [originalScope]: session,
        ...(sibling
          ? { "agent:main:sibling\u0000agent:main": { draft: "untouched", updatedAt: 2 } }
          : {}),
      },
    }),
  );
  const entry = () =>
    readChatOutboxRecovery(state).entries.find((row) => row.sourceScopeKey === originalScope)!;
  const destination = (scope = firstScope) => captureChatOutboxRecoveryDestination(state, scope)!;
  const stored = () => readStoredOutboxStore(sessionStorage, storageTargetForComposer(state));
  const entries = () => readChatOutboxRecovery(state).entries;
  return {
    state,
    session,
    source,
    entry,
    stored,
    entries,
    legacy: () => readStoredOutboxStore(sessionStorage, source),
    saveLegacy: (store: ReturnType<typeof stored>) =>
      writeStoredOutboxStore(sessionStorage, source, store),
    save: (store: ReturnType<typeof stored>) =>
      writeStoredOutboxStore(sessionStorage, storageTargetForComposer(state), store),
    restore: (row = entry(), scope = firstScope) =>
      restoreChatOutboxRecovery(state, row, destination(scope)),
    discard: (row = entry(), isCurrent?: () => boolean) =>
      discardChatOutboxRecovery(state, row, isCurrent),
    retire: (rows = entries()) => retireDeliveredChatOutboxRecovery(state, rows),
    expectRetained: () => {
      expect(stored().sessions).toEqual({});
      expect(entry().session).toEqual(session);
    },
  };
}
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reopenStorage() {
  const reopened = createStorageMock();
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)!;
    reopened.setItem(key, sessionStorage.getItem(key)!);
  }
  vi.stubGlobal("sessionStorage", reopened);
}

function interceptTransfer(
  f: ReturnType<typeof fixture>,
  intercept: (stage: string, commit: () => void) => void,
) {
  const set = sessionStorage.setItem.bind(sessionStorage);
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  const ownedKey = storageTargetForComposer(f.state).key;
  const apply = (key: string, value?: string) => {
    const commit = () => (value === undefined ? remove(key) : set(key, value));
    if (key !== f.source.key && key !== ownedKey) {
      commit();
      return;
    }
    const source = key === f.source.key;
    let stage = source ? "retire-remove" : "discard";
    if (value !== undefined) {
      const record = JSON.parse(value) as { recovery: Record<string, { sourceScopeKey: string }> };
      const staging = Object.values(record.recovery).some(
        (row) => row.sourceScopeKey === sourceScope,
      );
      stage = source ? (staging ? "claim" : "retire-write") : staging ? "stage" : "publish";
    }
    intercept(stage, commit);
  };
  const writes = vi
    .spyOn(sessionStorage, "setItem")
    .mockImplementation((key, value) => apply(key, value));
  const removals = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => apply(key));
  return () => {
    writes.mockRestore();
    removals.mockRestore();
  };
}

function deliveryFixture(idempotencyKey = "original-attempt") {
  const f = fixture("queue");
  const state = Object.assign(f.state, {
    sessionKey: "agent:main:legacy",
    currentSessionId: "original-session",
    chatMessages: [deliveredMessage(idempotencyKey)] as unknown[],
  });
  return { ...f, state };
}

function fillDestination(f: ReturnType<typeof fixture>, occupied: "queue" | "pending" | "draft") {
  const store = f.stored();
  const prefix =
    occupied === "pending"
      ? "opaque-"
      : `agent:main:${occupied === "queue" ? "occupied" : "draft"}-`;
  const key = (index: number) => `${prefix}${index}\u0000agent:main`;
  for (let index = 0; index < 20; index++) {
    store.sessions[key(index)] = storedSession(
      occupied === "queue"
        ? {
            queue: [
              queueItem({ id: "occupied-" + index, text: "keep", createdAt: index, storageScope }),
            ],
          }
        : {
            draft: (occupied === "pending" ? "pending " : "existing input ") + index,
            ...(occupied === "pending" ? { awaitingDefaults: true } : {}),
          },
      occupied === "queue" ? Date.now() + 1000 + index : index + 1,
    );
  }
  f.save(store);
  return key;
}

it.each(["original-attempt", "original-attempt:user"])("retires delivered %s", (idempotencyKey) => {
  const f = deliveryFixture(idempotencyKey);
  expect(f.retire()).toBe("retired");
  expect(f.entries()).toEqual([]);
  expect([f.stored().recovery, f.stored().sessions]).toEqual([{}, {}]);
  expect(f.state).toMatchObject({ chatQueue: [], chatMessage: "" });
});

it.each([
  "local-copy",
  "session",
  "scope",
  "text-only",
  "assistant",
  "no-run-id",
  "unowned-draft",
] as const)("keeps saved queue input when delivery retirement is unsafe: %s", (mismatch) => {
  const f = deliveryFixture();
  const message = deliveredMessage(
    mismatch === "text-only" ? "another-attempt" : "original-attempt",
    mismatch === "local-copy",
  );
  message.role = mismatch === "assistant" ? "assistant" : "user";
  f.state.chatMessages = [message];
  if (mismatch === "session") {
    f.state.currentSessionId = "replacement-session";
  } else if (mismatch === "scope") {
    f.state.sessionKey = firstScope.sessionKey;
  } else if (mismatch === "no-run-id" || mismatch === "unowned-draft") {
    const legacy = f.legacy();
    if (mismatch === "no-run-id") {
      delete legacy.sessions[sourceScope]!.queue![0]!.sendRunId;
    } else {
      legacy.sessions[sourceScope]!.draft = "Keep this draft";
      f.state.chatMessages = [
        { role: "user", __openclaw: { seq: 7, idempotencyKey: "original-attempt:user" } },
      ];
    }
    f.saveLegacy(legacy);
  }
  const before = sessionStorage.getItem(f.source.key);
  const entries = f.entries();
  expect(f.retire(entries)).toBe("unchanged");
  expect(f.entries()).toEqual(entries);
  expect(sessionStorage.getItem(f.source.key)).toBe(before);
  expect(f.stored().recovery).toEqual({});
});

it("retains the draft and unproven inputs when only one owned submission was delivered", () => {
  const f = deliveryFixture();
  const legacy = f.legacy();
  const delivered = legacy.sessions[sourceScope]!.queue![0]!;
  legacy.sessions = {};
  f.saveLegacy(legacy);
  const owned = f.stored();
  owned.recovery.owned = recovery({
    draft: "Keep this draft",
    updatedAt: 1,
    queue: [delivered, queueItem({ id: "unsent", text: "Still unsent", createdAt: 2 })],
  });
  f.save(owned);
  f.state.chatMessages = [
    { role: "user", __openclaw: { seq: 7, idempotencyKey: "original-attempt:user" } },
  ];
  expect(f.retire()).toBe("retired");
  expect(f.entries()).toMatchObject([
    { id: "owned", session: { draft: "Keep this draft", queue: [{ id: "unsent" }] } },
  ]);
  expect(f.entries()[0]!.session.queue).toHaveLength(1);
});

it.each(["recovery", "history"] as const)("fences retirement after %s changes", (change) => {
  const f = deliveryFixture();
  const entries = f.entries();
  if (change === "recovery") {
    const legacy = f.legacy();
    legacy.sessions[sourceScope]!.draft = "Newer intent";
    f.saveLegacy(legacy);
  } else {
    interceptTransfer(f, (stage, commit) => {
      commit();
      if (stage === "claim" || stage === "retire-write") {
        f.state.chatMessages = [];
      }
    });
  }
  const before = sessionStorage.getItem(f.source.key);
  expect(f.retire(entries)).toBe("conflict");
  if (change === "recovery") {
    expect(sessionStorage.getItem(f.source.key)).toBe(before);
  }
  expect(f.entries()[0]?.session.queue).toHaveLength(1);
});

it("offers textless recovery input but preserves and hides canonical clear fences", () => {
  const f = fixture("draft");
  const fence = { updatedAt: 12, draftRevision: 12 };
  const legacy = f.legacy();
  legacy.sessions["global\u0000agent:main"] = fence;
  legacy.recovery = {
    cleared: recovery(fence, 3),
    attachment: recovery(
      storedSession({ queue: [queueItem({ text: "", attachments: [attachment] })] }),
    ),
    goal: recovery(storedSession({ goalMode: { action: "start" } }, 2)),
    reply: recovery(storedSession({ replyTarget: { messageId: "message", text: "quoted" } }, 3)),
  };
  f.saveLegacy(legacy);
  const owned = f.stored();
  owned.recovery.cleared = recovery(fence);
  f.save(owned);
  const before = sessionStorage.getItem(f.source.key);
  expect(f.entries().map((entry) => entry.id)).toEqual([
    "legacy-session:" + sourceScope,
    ...["attachment", "goal", "reply"].map((id) => "legacy-recovery:" + id),
  ]);
  expect(f.entries()[0]?.session.draft).toBe("Retained draft 雪");
  expect(sessionStorage.getItem(f.source.key)).toBe(before);
  expect(f.stored().recovery.cleared).toBeUndefined();
  expect(f.legacy().sessions["global\u0000agent:main"]).toEqual(fence);
});

it.each(["queue", "draft"] as const)("discards %s without changing the composer", (kind) => {
  const f = fixture(kind, true);
  const entry = f.entry();
  const owned = f.stored();
  owned.sessions[scopeKey(firstScope)] = {
    draft: "current input",
    updatedAt: 10,
    draftRevision: 10,
  };
  f.save(owned);
  f.state.chatMessage = "current input";
  expect(f.discard(entry)).toBe("discarded");
  expect(f.state.chatMessage).toBe("current input");
  expect(f.stored().sessions).toEqual(owned.sessions);
  expect(f.entries().map((row) => row.session.draft)).toEqual(["untouched"]);
  expect(f.discard(entry)).toBe("conflict");
});

it.each(["account", "gateway", "revision", "incognito", "confirmation"] as const)(
  "fences discard after %s changes",
  (change) => {
    const f = fixture("draft");
    const entry = f.entry();
    if (change === "revision") {
      const legacy = f.legacy();
      legacy.sessions[sourceScope] = { draft: "newer", draftRevision: 2, updatedAt: 2 };
      f.saveLegacy(legacy);
    } else if (change === "account") {
      f.state.client.recoveryScope = "account-b";
    } else if (change === "gateway") {
      f.state.settings.gatewayUrl = "wss://other.test";
    } else if (change === "incognito") {
      Object.assign(f.state, { selectedChatSessionIncognito: true });
    }
    const before = sessionStorage.getItem(f.source.key);
    expect(f.discard(entry, () => change !== "confirmation")).toBe("conflict");
    expect(sessionStorage.getItem(f.source.key)).toBe(before);
    expect(f.stored().sessions).toEqual({});
  },
);

it("retires attachment payloads only after the last recovery copy is discarded", () => {
  const f = fixture("queue");
  const reference = { key: "blob", tabId: "this-tab", recoveryScope: "account-a" };
  const legacy = f.legacy();
  Object.assign(legacy.sessions[sourceScope]!.queue![0]!, {
    attachmentPayload: reference,
    attachments: [attachment],
  });
  f.saveLegacy(legacy);
  const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads").mockImplementation(async () => {
    expect(f.entries()).toEqual([]);
  });
  expect(f.discard()).toBe("discarded");
  expect(cleanup).toHaveBeenCalledExactlyOnceWith([reference]);
});

const stages = ["claim", "stage", "retire-write", "retire-remove", "publish"] as const;
const transferCases = stages.flatMap((stage) =>
  ["throw", "after-write"].flatMap((failure) =>
    (stage === "publish" ? (["queue", "draft"] as const) : (["queue"] as const)).map((kind) => ({
      stage,
      failure,
      kind,
      discard: false,
    })),
  ),
);
it.each([
  ...transferCases,
  ...["claim", "stage", "retire-remove", "discard"].map((stage) => ({
    stage,
    failure: "throw",
    kind: "queue" as const,
    discard: true,
  })),
])(
  "retains $kind across $stage $failure (discard=$discard)",
  ({ stage, failure, kind, discard }) => {
    const f = fixture(kind, stage === "retire-write");
    const original = f.entry();
    let failed = false;
    const reset = interceptTransfer(f, (currentStage, commit) => {
      if (currentStage === stage) {
        failed = true;
        if (failure === "after-write") {
          commit();
        }
        throw new Error("Injected " + stage);
      }
      commit();
    });
    expect(discard ? f.discard(original) : f.restore(original)).toBe("storage-failed");
    expect(failed).toBe(true);
    reset();
    reopenStorage();
    const committed = stage === "publish" && failure === "after-write";
    if (committed) {
      expect(f.entry()).toBeUndefined();
      expect(f.restore(original, secondScope)).toBe("conflict");
    } else {
      f.expectRetained();
      expect(f.entries().filter((row) => row.sourceScopeKey === sourceScope)).toHaveLength(1);
      expect(discard ? f.discard() : f.restore(f.entry(), secondScope)).toBe(
        discard ? "discarded" : "restored",
      );
    }
    const sessions = f.stored().sessions;
    if (discard) {
      expect(sessions).toEqual({});
    } else {
      const scope = committed ? firstScope : secondScope;
      const key = scopeKey(scope);
      expect(Object.keys(sessions)).toEqual([key]);
      expect(sessions[key]).toMatchObject(
        kind === "draft"
          ? { draft: f.session.draft }
          : {
              queue: [{ id: "original-input", text: "Retained queue 雪", ...scope, storageScope }],
            },
      );
    }
    expect(f.entries().filter((row) => row.sourceScopeKey === sourceScope)).toEqual([]);
    if (stage === "retire-write") {
      expect(f.entries()[0]?.session.draft).toBe("untouched");
    }
  },
);

it.each([
  [sourceScope, "agent:main:legacy", true, {}],
  ["main\u0000agent:main", "agent:main:main", true, {}],
  [sourceScope, firstScope.sessionKey, false, { attachments: [attachment] }],
  [
    sourceScope,
    firstScope.sessionKey,
    true,
    { intent: { kind: "session-goal-start", version: 1, issuedAtMs: 1 } },
  ],
  [sourceScope, firstScope.sessionKey, true, { localCommandName: "clear" }],
  [sourceScope, firstScope.sessionKey, true, { queueMode: "steer" }],
] satisfies Array<[string, string, boolean, Partial<ChatQueueItem>]>)(
  "preserves admission when restoring %s to %s (retained=%s)",
  (source, destination, retained, input) => {
    const f = fixture("queue", false, source);
    const legacy = f.legacy();
    Object.assign(legacy.sessions[source]!.queue![0]!, input);
    f.saveLegacy(legacy);
    const scope = { sessionKey: destination, agentId: "main" };

    expect(f.restore(f.entry(), scope)).toBe("restored");

    const restored = f.stored().sessions[scopeKey(scope)]?.queue?.[0];
    expect(restored).toMatchObject({
      ...input,
      sendAttempts: retained ? 1 : 0,
      sendState: retained ? "held" : "failed",
    });
    if (retained) {
      expect(restored).toMatchObject({
        sendRunId: "original-attempt",
        sessionId: "original-session",
      });
    } else {
      expect(restored).not.toHaveProperty("sendRunId");
      expect(restored).not.toHaveProperty("sessionId");
    }
  },
);

it.each([
  ...(["account", "client"] as const).map((change) => ({
    boundary: "claim" as const,
    change,
  })),
  ...(["stage", "retire"] as const).map((boundary) => ({ boundary, change: "account" as const })),
])("retains recovery across reentrant $change replacement at $boundary", ({ boundary, change }) => {
  const f = fixture("draft");
  const original = f.entry();
  let changed = false;
  const reset = interceptTransfer(f, (stage, commit) => {
    commit();
    if (!changed && stage === (boundary === "retire" ? "retire-remove" : boundary)) {
      changed = true;
      if (change === "account") {
        f.state.client.recoveryScope = "account-b";
      } else {
        f.state.client = { ...f.state.client };
      }
    }
  });
  expect(f.restore(original)).toBe("conflict");
  reset();
  expect(changed).toBe(true);
  if (change === "account") {
    expect(f.entries()).toEqual([]);
    f.state.client.recoveryScope = "account-a";
  }
  f.expectRetained();
  expect(f.restore(f.entry(), secondScope)).toBe("restored");
  expect(f.stored().sessions[scopeKey(secondScope)]?.draft).toBe(f.session.draft);
  if (boundary !== "claim") {
    expect(Object.keys(f.stored().sessions)).toEqual([scopeKey(secondScope)]);
  }
});

it.each([
  { kind: "queue", occupied: "queue" },
  { kind: "draft", occupied: "queue" },
  { kind: "draft", occupied: "pending" },
  { kind: "queue", occupied: "draft" },
] as const)("retains $kind when destination is full of $occupied", ({ kind, occupied }) => {
  const f = fixture(kind);
  const key = fillDestination(f, occupied);
  const before = f.stored().sessions;
  expect(f.restore()).toBe("storage-failed");
  expect(f.stored().sessions).toEqual(before);
  expect(Object.keys(f.stored().sessions)).toHaveLength(20);
  reopenStorage();
  expect(f.entry().session).toEqual(f.session);
  if (occupied === "pending") {
    const ordinary = f.stored();
    ordinary.sessions[scopeKey(firstScope)] = { ...f.session, updatedAt: Date.now() };
    f.save(ordinary);
    expect(f.stored().sessions[scopeKey(firstScope)]).toBeUndefined();
    expect(f.entry().session).toEqual(f.session);
  }
  const freed = f.stored();
  delete freed.sessions[key(0)];
  f.save(freed);
  expect(f.restore(f.entry(), secondScope)).toBe("restored");
  const after = f.stored().sessions;
  expect(Object.keys(after)).toHaveLength(20);
  for (let index = 1; index < 20; index++) {
    expect(after[key(index)]).toEqual(before[key(index)]);
  }
  expect(after[scopeKey(secondScope)]).toMatchObject(
    kind === "draft" ? { draft: f.session.draft } : { queue: [{ id: "original-input" }] },
  );
  expect(after[scopeKey(firstScope)]).toBeUndefined();
  expect(f.entries()).toEqual([]);
});
