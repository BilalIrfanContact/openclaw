import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { PluginStateOperationInput } from "./plugin-state-operation-contract.js";
import { executePluginStateOperation } from "./plugin-state-operation.kernel.js";
import { selectPluginStateEntry, upsertPluginStateEntry } from "./plugin-state-store.kernel.js";
import type { PluginStateOperationTransaction } from "./plugin-state-store.types.js";

function withDatabase(run: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE plugin_state_entries (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  ) STRICT`);
  try {
    run(db);
  } finally {
    db.close();
  }
}

function operation(db: DatabaseSync, namespaces: string[], maxEntries: number) {
  const input: PluginStateOperationInput = {
    module: {
      modulePath: import.meta.filename,
      boundaryRoot: import.meta.dirname,
      origin: "bundled",
      pluginId: "fixture",
    },
    exportName: "fixture",
    stores: namespaces.map((namespace) => ({
      pluginId: "fixture",
      namespace,
      maxEntries,
      overflowPolicy: "reject-new",
      defaultTtlMs: undefined,
    })),
    writeStores: namespaces.map((_, index) => index),
    command: { type: "fixture", input: null },
    receiptId: "fixture",
  };
  return (run: (tx: PluginStateOperationTransaction) => unknown) =>
    runSqliteImmediateTransactionSync(db, () =>
      executePluginStateOperation({ db, path: ":memory:" }, input, (_command, tx) => run(tx)),
    );
}

it("refuses NUL plugin keys before PostgreSQL reads or writes", () => {
  const db = new DatabaseSync(":memory:");
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  try {
    const scope = { pluginId: "test", namespace: "test", key: "nul\0tail" };
    for (const run of [
      () => selectPluginStateEntry(db, { ...scope, now: 1 }),
      () =>
        upsertPluginStateEntry(db, {
          plugin_id: scope.pluginId,
          namespace: scope.namespace,
          entry_key: scope.key,
          value_json: "{}",
          created_at: 1,
          expires_at: null,
        }),
    ]) {
      expect(run).toThrow(
        expect.objectContaining({
          code: "PLUGIN_STATE_INVALID_INPUT",
          message: "PostgreSQL plugin state keys cannot contain NUL characters.",
        }),
      );
    }
  } finally {
    db.close();
  }
});

it.each([
  { scanned: false, expiredCount: 1, probes: 0 },
  { scanned: true, expiredCount: 1, probes: 1 },
  { scanned: false, expiredCount: 1_025, probes: 1 },
])(
  "preserves cleanup, capacity, and read-own-write ($scanned, $expiredCount expired)",
  ({ scanned, expiredCount, probes }) =>
    withDatabase((db) => {
      db.exec(`INSERT INTO plugin_state_entries VALUES
    ('fixture', 'bounded', 'live', '1', 1, NULL),
    ('fixture', 'bounded', 'removed', '2', 2, NULL),
    ('fixture', 'bounded', 'expired', '3', 3, 1);`);
      const insert = db.prepare(
        "INSERT INTO plugin_state_entries VALUES ('fixture', 'bounded', ?, '0', 3, 1)",
      );
      for (let index = 1; index < expiredCount; index++) {
        insert.run(`expired-${index}`);
      }
      const run = operation(db, ["bounded"], 2);
      const counter = trackSqliteStatementExecutions(
        db,
        ["aggregate", "probe", "delete"],
        (sql) => {
          if (sql.startsWith("select sum(")) {
            return "aggregate";
          }
          if (sql.startsWith('select "expires_at"')) {
            return "probe";
          }
          if (sql.startsWith("delete from")) {
            return "delete";
          }
          return null;
        },
      );
      try {
        const result = run((tx) => {
          if (scanned) {
            tx.entries(0);
          }
          tx.delete(0, "removed");
          tx.set(0, "live", 4);
          tx.set(0, "new", 5);
          return tx.entries(0);
        });
        expect(result.value).toEqual([
          expect.objectContaining({ key: "live", value: 4 }),
          expect.objectContaining({ key: "new", value: 5 }),
        ]);
        expect(counter.counts).toEqual({
          aggregate: scanned ? 0 : 1,
          probe: probes,
          delete: expiredCount > 1_024 ? 3 : 2,
        });
        expect(
          db.prepare("SELECT entry_key FROM plugin_state_entries ORDER BY entry_key").all(),
        ).toEqual([{ entry_key: "live" }, { entry_key: "new" }]);
        expect(() =>
          run((tx) => {
            tx.set(0, "over-capacity", 6);
          }),
        ).toThrow(/reached its 2-row limit/);
      } finally {
        counter.restore();
      }
    }),
);

it.each([1, 2, 4, 5])(
  "shares small-operation retention facts without changing namespace limits (%i scopes)",
  (scopeCount) =>
    withDatabase((db) => {
      const namespaces = Array.from({ length: scopeCount }, (_, index) => `scope-${index}`);
      const seed = db.prepare(
        "INSERT INTO plugin_state_entries VALUES ('fixture', ?, ?, '0', 1, ?)",
      );
      for (const namespace of namespaces) {
        seed.run(namespace, "live", null);
        seed.run(namespace, "expired", 1);
      }
      const counter = trackSqliteStatementExecutions(db, ["aggregate"], (sql) =>
        sql.startsWith("select sum(") ? "aggregate" : null,
      );
      const run = operation(db, namespaces, 1);
      try {
        run((tx) => {
          tx.set(0, "live", 1);
          for (let index = 1; index < scopeCount; index++) {
            expect(tx.lookup(index, "live")).toBe(0);
            expect(tx.delete(index, "live")).toBe(true);
            tx.set(index, "replacement", index);
            expect(tx.lookup(index, "replacement")).toBe(index);
          }
          expect(() => tx.set(0, "over-capacity", 2)).toThrow(/1-row limit/);
          expect(tx.lookup(0, "live")).toBe(1);
        });
        expect(counter.counts.aggregate).toBe(scopeCount <= 4 ? 1 : scopeCount);
        expect(db.prepare("SELECT COUNT(*) AS count FROM plugin_state_entries").get()).toEqual({
          count: scopeCount,
        });
        expect(() =>
          run((tx) => {
            tx.set(0, "live", 99);
            throw new Error("rollback");
          }),
        ).toThrow("rollback");
        expect(
          db
            .prepare("SELECT value_json FROM plugin_state_entries WHERE namespace=?")
            .get("scope-0"),
        ).toEqual({ value_json: "1" });
      } finally {
        counter.restore();
      }
    }),
);

it.each([false, true])(
  "adds no retention work for a scanned write or a delete-only sibling (scanned=%s)",
  (scanned) =>
    withDatabase((db) => {
      db.exec(
        "INSERT INTO plugin_state_entries VALUES ('fixture', 'other', 'removed', '0', 1, NULL)",
      );
      const run = operation(db, ["written", "other", "unused"], 1);
      const counter = trackSqliteStatementExecutions(db, ["aggregate", "lookup"], (sql) => {
        if (sql.startsWith("select sum(")) {
          return "aggregate";
        }
        return sql.startsWith('select "entry_key"') && sql.includes('"entry_key" =')
          ? "lookup"
          : null;
      });
      try {
        run((tx) => {
          if (scanned) {
            tx.entries(0);
          }
          tx.set(0, "new", 1);
          expect(tx.delete(1, "removed")).toBe(true);
          expect(tx.lookup(0, "new")).toBe(1);
        });
        expect(counter.counts).toEqual({ aggregate: scanned ? 0 : 1, lookup: scanned ? 0 : 1 });
        expect(db.prepare("SELECT namespace FROM plugin_state_entries").all()).toEqual([
          { namespace: "written" },
        ]);
      } finally {
        counter.restore();
      }
    }),
);
