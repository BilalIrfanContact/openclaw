import { describe, expect, it, vi } from "vitest";
import { importClaudeHistory } from "./session-catalog-history.js";
import { parseTranscriptLine } from "./session-catalog-transcript.js";

// mock-isolation: Catalog projection must not initialize an unrelated provider SDK.
vi.mock("@google/genai", () => {
  throw new Error("Anthropic catalog history must not initialize the Google SDK");
});

const appended: Array<Record<string, unknown>> = [];
function importItems(items: Parameters<typeof importClaudeHistory>[0]["items"]) {
  appended.length = 0;
  return importClaudeHistory({
    items,
    threadId: "thread-1",
    storePath: "/tmp/sessions.json",
    sessionId: "session-1",
    sessionKey: "agent:main:catalog-adopt",
    agentId: "main",
    config: {},
  });
}

function parseMessage(role: string, content: string, flags: Record<string, unknown> = {}) {
  const row = { type: role, ...flags, message: { role, content } };
  return parseTranscriptLine(Buffer.from(JSON.stringify(row)));
}
const userMessage = (text: string, timestamp: string) => ({ type: "userMessage", text, timestamp });

// mock-isolation: Exercise native message projection without opening the transcript store.
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  withSessionTranscriptWrite: async (
    _params: unknown,
    run: (transcript: {
      appendMessage: (input: { message: Record<string, unknown> }) => Promise<void>;
    }) => Promise<void>,
  ) => {
    await run({
      appendMessage: async ({ message }) => {
        appended.push(message);
      },
    });
  },
}));

describe("importClaudeHistory", () => {
  it.each(["", "{", "null", "[]", "42", '"text"', "{}"])(
    "ignores malformed JSON and non-message transcript rows: %j",
    (line) => {
      expect(parseTranscriptLine(Buffer.from(line))).toBeUndefined();
    },
  );

  it("omits metadata without changing other native conversation rows", async () => {
    const items = [
      parseMessage("user", "private skill instructions", { isMeta: true }),
      parseMessage("user", "run the review", { uuid: "operator-1" }),
      parseMessage("user", "compacted context", { isCompactSummary: true }),
      parseMessage("user", "transcript-only context", { isVisibleInTranscriptOnly: true }),
      parseMessage("assistant", "done"),
    ].filter((item) => item !== undefined);

    await importItems(items);

    expect(JSON.stringify(appended)).not.toContain("private skill instructions");
    const userRow = appended.find((message) => message.content === "run the review");
    expect(userRow?.provenance).toBeUndefined();
    // Imported prompts must not be swallowed as OpenClaw self-echoes.
    expect(userRow?.["__openclaw"]).toMatchObject({ mirrorOrigin: "claude-catalog-import" });
    expect(appended.map((message) => message.content)).toEqual(
      expect.arrayContaining(["run the review", "compacted context", "transcript-only context"]),
    );
    const assistantRow = appended.find((message) => message.role === "assistant");
    expect(assistantRow).toBeDefined();
    expect(assistantRow?.["__openclaw"]).toBeUndefined();
  });

  it("preserves Date.parse semantics for valid strings and falls back for invalid values", async () => {
    const fallbackTimestamp = new Date("2026-07-18T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fallbackTimestamp);
    try {
      await importItems([
        userMessage("invalid", "not-a-date"),
        userMessage("numeric year", "2026"),
        userMessage("numeric zero", "0"),
        userMessage("pre-epoch", "1969-12-31T23:59:59.000Z"),
      ]);
    } finally {
      vi.useRealTimers();
    }

    expect(appended).toHaveLength(4);
    expect(appended.map((message) => message.timestamp)).toEqual([
      -1_000,
      Date.parse("0"),
      Date.parse("2026"),
      fallbackTimestamp + 3,
    ]);
    expect(JSON.stringify(appended)).not.toContain('"timestamp":null');
  });

  it("omits empty native reasoning records instead of rendering a placeholder", async () => {
    await importItems([
      { type: "reasoning", content: [{ type: "thinking", thinking: "" }], uuid: "r-1" },
      { type: "assistantMessage", text: "AUTH_OK", uuid: "a-1" },
    ]);

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("AUTH_OK");
    expect(JSON.stringify(appended)).not.toContain("Unsupported Claude transcript item");
  });

  it("retains the placeholder for unsupported non-reasoning records", async () => {
    await importItems([{ type: "toolCall", content: [{ type: "tool_use" }], uuid: "t-1" }]);

    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended)).toContain("Unsupported Claude transcript item");
  });
});
