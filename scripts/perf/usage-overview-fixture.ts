// Own synthetic state only. Run with node --import ./scripts/tsx.mjs.
// Seeds an isolated state directory with team-shaped usage transcripts over 30 days;
// the Gateway's startup refresh builds the usage rollups. Ground truth is stored per
// UTC quarter so any quarter-aligned report range has an exact expected total.
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../src/daemon/constants.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "1000" },
    seed: { type: "string", default: "967" },
    port: { type: "string", default: "40981" },
    "large-fraction": { type: "string", default: "0.005" },
    "medium-fraction": { type: "string", default: "0.09" },
  },
});
if (!values["state-dir"]) {
  throw new Error("--state-dir is required and must name a new directory");
}
const stateDir = path.resolve(values["state-dir"]);
const sessionCount = Number(values.sessions);
const port = Number(values.port);
const largeFraction = Number(values["large-fraction"]);
const mediumFraction = Number(values["medium-fraction"]);
const DAY = 86_400_000;
const QUARTER = 900_000;
const now = Date.now();

mkdirSync(path.dirname(stateDir), { recursive: true });
mkdirSync(stateDir, { mode: 0o700 });
for (const directory of ["home", "tmp", "workspace"]) {
  mkdirSync(path.join(stateDir, directory));
}
const configPath = path.join(stateDir, "openclaw.json");
const profile = `usage-overview-${port}`;
const env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_PROFILE: profile,
  OPENCLAW_LAUNCHD_LABEL: resolveGatewayLaunchAgentLabel(profile),
  OPENCLAW_SYSTEMD_UNIT: resolveGatewaySystemdServiceName(profile),
  OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
};
process.env = { ...env };
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "none" },
    controlUi: { enabled: false },
    tailscale: { mode: "off" },
  },
  discovery: { mdns: { mode: "off" } },
  browser: { enabled: false },
  plugins: { enabled: false },
  cron: { enabled: false },
  update: { checkOnStart: false },
  agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
  logging: { file: path.join(stateDir, "gateway.log") },
} satisfies OpenClawConfig;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const [
  { writeSessionEntry },
  { appendTranscriptEventsInTransaction },
  agentDb,
  stateDb,
  users,
  usersSchema,
  kysely,
] = await Promise.all([
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/state/user-profiles-internal.js"),
  import("../../src/state/user-profiles-schema.js"),
  import("../../src/infra/kysely-sync.js"),
]);
const databaseOptions = { agentId: "main", env };
usersSchema.ensureUserProfilesSchema({ env });
stateDb.runOpenClawStateWriteTransaction(
  ({ db }) => {
    kysely.executeSqliteQuerySync(
      db,
      users
        .userProfilesDb(db)
        .insertInto("user_profiles")
        .values(
          Array.from({ length: 24 }, (_, index) => ({
            id: `usage-profile-${index}`,
            display_name: `Synthetic teammate ${index}`,
            avatar: null,
            avatar_mime: null,
            avatar_sha256: null,
            merged_into: null,
            created_at: now,
            updated_at: now,
          })),
        ),
    );
  },
  { env },
);

const digest = createHash("sha256").update(values.seed!).digest();
let randomState = digest.readUInt32LE(0);
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
const MODELS = [
  ["anthropic", "claude-opus-4-1"],
  ["anthropic", "claude-sonnet-4-5"],
  ["openai", "gpt-5.1"],
  ["openai", "gpt-5.1-codex"],
  ["openai", "gpt-5-mini"],
  ["google", "gemini-2.5-pro"],
  ["openrouter", "qwen3-coder"],
  ["anthropic", "claude-haiku-4-5"],
] as const;
const TOOLS = Array.from({ length: 30 }, (_, index) => `tool_${index}`);

// Ground truth: exact sums per UTC quarter, so any quarter-aligned range is exact.
const truth = new Map<
  number,
  { tokens: number; cost: number; input: number; cacheRead: number; messages: number }
>();
const classes = { small: 0, medium: 0, large: 0 };
let eventCount = 0;
const largeCount = Math.max(4, Math.round(sessionCount * largeFraction));
const started = performance.now();
const agent = agentDb.openOpenClawAgentDatabase({ agentId: "main" });
for (let index = 0; index < sessionCount; index++) {
  const sessionId = `usage-session-${index}`;
  const sessionKey = `agent:main:${sessionId}`;
  const kind = index < largeCount ? "large" : random() < mediumFraction ? "medium" : "small";
  classes[kind]++;
  // Timestamps for each assistant turn.
  const turns: number[] = [];
  if (kind === "large") {
    // Long-running agent: a turn in most 15-minute quarters for 30 days.
    const start = now - 30 * DAY + Math.floor(random() * DAY);
    for (let t = start; t < now - 60_000; t += QUARTER) {
      const perQuarter = random() < 0.1 ? 0 : random() < 0.7 ? 1 : 2;
      for (let k = 0; k < perQuarter; k++) {
        turns.push(t + Math.floor(random() * (QUARTER - 1000)));
      }
    }
  } else {
    const span = kind === "medium" ? (1 + random() * 2) * DAY : (0.1 + random() * 2) * 3_600_000;
    const count =
      kind === "medium" ? 50 + Math.floor(random() * 250) : 2 + Math.floor(random() * 10);
    const start = now - Math.floor(random() ** 1.5 * 30 * DAY) - span;
    for (let k = 0; k < count; k++) {
      turns.push(Math.floor(start + (span * k) / count));
    }
  }
  turns.sort((a, b) => a - b);
  const lastAt = turns.at(-1) ?? now - DAY;
  const firstAt = turns[0] ?? lastAt;
  const modelPool =
    kind === "large" ? MODELS : [pick(MODELS), ...(random() < 0.3 ? [pick(MODELS)] : [])];
  const toolPool = kind === "large" ? TOOLS : TOOLS.slice(0, 3 + Math.floor(random() * 10));
  const events: unknown[] = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(firstAt).toISOString() },
  ];
  let parentId: string | null = null;
  for (const [turn, timestamp] of turns.entries()) {
    const userId = `${sessionId}-u${turn}`;
    events.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: new Date(timestamp - 2000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "next step" }],
        timestamp: timestamp - 2000,
      },
    });
    const [provider, model] = pick(modelPool);
    const input = 500 + Math.floor(random() * 20_000);
    const output = 100 + Math.floor(random() * 2_000);
    const cacheRead =
      kind === "small" ? Math.floor(random() * 20_000) : 20_000 + Math.floor(random() * 180_000);
    const cacheWrite = Math.floor(random() * 4_000);
    const totalTokens = input + output + cacheRead + cacheWrite;
    const costInput = input * 3e-6;
    const costOutput = output * 15e-6;
    const costRead = cacheRead * 0.3e-6;
    const costWrite = cacheWrite * 3.75e-6;
    const cost = costInput + costOutput + costRead + costWrite;
    const toolCalls = Array.from({ length: Math.floor(random() * 4) }, (_, k) => ({
      type: "toolCall",
      id: `${sessionId}-t${turn}-${k}`,
      name: pick(toolPool),
      arguments: {},
    }));
    const assistantId = `${sessionId}-a${turn}`;
    events.push({
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "assistant",
        provider,
        model,
        stopReason: random() < 0.02 ? "error" : toolCalls.length ? "toolUse" : "stop",
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens,
          cost: {
            input: costInput,
            output: costOutput,
            cacheRead: costRead,
            cacheWrite: costWrite,
            total: cost,
          },
        },
        content: [{ type: "text", text: "done" }, ...toolCalls],
        timestamp,
      },
    });
    parentId = assistantId;
    const quarter = Math.floor(timestamp / QUARTER) * QUARTER;
    const bucket = truth.get(quarter) ?? {
      tokens: 0,
      cost: 0,
      input: 0,
      cacheRead: 0,
      messages: 0,
    };
    bucket.tokens += totalTokens;
    bucket.cost += cost;
    bucket.input += input;
    bucket.cacheRead += cacheRead;
    bucket.messages += 1;
    truth.set(quarter, bucket);
  }
  const profileId = `usage-profile-${index % 24}`;
  agentDb.runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, sessionKey, {
      sessionId,
      updatedAt: lastAt,
      createdAt: firstAt,
      sessionStartedAt: firstAt,
      lastInteractionAt: lastAt,
      lastActivityAt: lastAt,
      lifecycleRevision: `usage-${index}`,
      label: `Synthetic ${kind} ${index}`,
      displayName: `Usage fixture session ${index}`,
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: profileId },
      visibility: "shared",
      status: "done",
      modelProvider: modelPool[0]![0],
      model: modelPool[0]![1],
    });
    // SAFETY: Synthetic events follow the persisted transcript shape.
    for (let offset = 0; offset < events.length; offset += 2_000) {
      appendTranscriptEventsInTransaction(
        database,
        { ...databaseOptions, sessionKey, sessionId },
        events.slice(offset, offset + 2_000) as never,
      );
    }
  }, databaseOptions);
  eventCount += events.length;
  if (index % 50 === 0) {
    await yieldTurn();
  }
}
agent.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
await agentDb.closeOpenClawAgentDatabasesAsync();
await stateDb.closeOpenClawStateDatabaseAsync();
const summary = {
  format: "openclaw-usage-overview-fixture-v1",
  profile,
  port,
  now,
  sessions: sessionCount,
  classes,
  eventCount,
  agentDatabaseBytes: statSync(agent.path).size,
  generationMs: performance.now() - started,
  truthQuarters: Object.fromEntries([...truth].toSorted((a, b) => a[0] - b[0])),
};
writeFileSync(path.join(stateDir, "usage-overview-fixture.json"), `${JSON.stringify(summary)}\n`);
const { truthQuarters: _q, ...printable } = summary;
console.log(JSON.stringify(printable, null, 2));
