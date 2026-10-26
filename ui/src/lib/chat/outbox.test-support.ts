import type { StoredComposerSession, StoredComposerState } from "./outbox-store-codec.ts";
import type { storageTargetForGateway } from "./outbox-store.ts";

export const storedSession = (overrides: Partial<StoredComposerSession> = {}, updatedAt = 1) => ({
  updatedAt,
  ...overrides,
});

export function seedStore(
  target: ReturnType<typeof storageTargetForGateway>,
  sessions: StoredComposerState["sessions"],
  recovery: StoredComposerState["recovery"] = {},
) {
  const store = { version: 4, gatewayOwner: target.gatewayOwner, sessions, recovery };
  sessionStorage.setItem(target.key, JSON.stringify(store));
  return store;
}

export function seedSource(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  const key = [target.legacyKey, target.previousKey, target.blobKey, target.key][version - 1]!;
  const source = sourceJson(target, version, sessions);
  sessionStorage.setItem(key, source);
  return { key, source };
}

export function sourceJson(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  return JSON.stringify({
    version,
    gatewayOwner: version === 1 ? undefined : target.gatewayOwner,
    recovery: version === 4 ? {} : undefined,
    sessions,
  });
}
