import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findSqlPortabilityViolations, main } from "../../scripts/check-sql-portability.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("rejects SQLite scalar extrema and negative LIMIT expressions without confusing aggregates or SQL data", () => {
  const cases = [
    ['eb.fn<number>("max", [eb.ref("a"), eb.val(0)])', ["multi-argument max"]],
    ['query.fn.agg<number>("min", ["a", "b", "c"])', ["multi-argument min"]],
    ['eb.fn("max", ["a"]).over()', []],
    ['eb.fn.max("a")', []],
    ["rows.limit(-1)", ["negative LIMIT"]],
    ["rows.limit(eb.lit(-1))", ["negative LIMIT"]],
    ["rows.limit((eb) => eb.lit(-1)).offset(10)", ["negative LIMIT"]],
    ["rows.limit((eb) => { return eb.lit(-1); })", ["negative LIMIT"]],
    ["rows.limit(sql`-1`)", ["negative LIMIT"]],
    ['rows.limit(sql.raw("-1"))', ["negative LIMIT"]],
    ["rows.limit(20).offset(10)", []],
    ["rows.limit(Math.max(0, input - 1))", []],
    ["rows.limit(valid ? depth : -1)", ["negative LIMIT"]],
    ["rows.limit(engineUnboundedRowLimit(db))", []],
    ["sql`SELECT max(a, coalesce(b, 0)) FROM t`", ["multi-argument max"]],
    ["sql`SELECT max(a), min(b) FROM t`", []],
    ["sql`SELECT max(${a}, ${b})`", ["multi-argument max"]],
    ["sql`SELECT a FROM t LIMIT -1 OFFSET 3`", ["negative LIMIT"]],
    ["sql`SELECT a FROM t LIMIT ${-1}`", ["negative LIMIT"]],
    ["const statement = `SELECT min(a, b) FROM t`", ["multi-argument min"]],
    ['db.prepare("SELECT a FROM t LIMIT -1")', ["negative LIMIT"]],
    ["sql`SELECT max(a), 'min(a,b) LIMIT -1', \"max(a,b)\" FROM t /* max(a,b) */`", []],
    ['// eb.fn("max", [a,b])\nconst prose = "max(a,b) LIMIT -1";', []],
  ] as const;
  using parser = createNativeTypeScriptParser();
  const sources = parser.parseSourceFiles(
    cases.map(([text], index) => ({
      fileName: `fixture-${index}.ts`,
      text,
    })),
  );
  for (const [index, [text, expected]] of cases.entries()) {
    const source = sources[index];
    if (!source) {
      throw new Error(`Missing parsed fixture ${index}`);
    }
    expect(
      findSqlPortabilityViolations(source).map((issue) => issue.construct),
      text,
    ).toEqual(expected);
  }
});

it("limits SQLite-only exemptions to the marked expression and makes the CLI fail on a new production violation", () => {
  const root = directories.make("sql-portability-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src", "query.ts");
  fs.writeFileSync(
    file,
    [
      "if (!postgres) {",
      '  const allowed = /* pg-sqlite-only: Guarded native SQLite branch. */ eb.fn("max", ["a", "b"]);',
      "  const bounded = /* pg-sqlite-only: Guarded recursive SQLite CTE. */ rows.limit(-1);",
      "  const raw = /* pg-sqlite-only: Private native SQLite index. */ sql`SELECT min(a, b)`;",
      "}",
      'const unguarded = eb.fn("min", ["a", "b"]);',
    ].join("\n"),
  );
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root)).toBe(1);
  expect(errors.mock.calls.flat()).toEqual([
    "src/query.ts:6: multi-argument min; use the database-engine dialect owner.",
  ]);
  fs.writeFileSync(file, 'const neutral = eb.fn("least", ["a", "b"]);');
  fs.writeFileSync(path.join(root, "src", "query.test.ts"), "rows.limit(-1)");
  expect(main(root)).toBe(0);
});
