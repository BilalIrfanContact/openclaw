import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

function authorizerFor(requestUserInput: CliBackendExecuteContext["requestUserInput"]) {
  return createClaudeCliUserInputAuthorizer({
    command: "/usr/local/bin/claude",
    args: [],
    cwd: "/tmp",
    env: {},
    prompt: "test",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "test",
    useResume: false,
    timeoutMs: 30_000,
    requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }),
    requestUserInput,
  });
}

const options = (...labels: string[]) =>
  labels.map((label) => ({ label, description: "Use " + label }));
const validOptions = options("A", "B");
const question = (overrides: Record<string, unknown> = {}) => ({
  header: "Stack",
  question: "Q?",
  options: validOptions,
  multiSelect: false,
  ...overrides,
});
const malformed = (overrides: Record<string, unknown>) => ({ questions: [question(overrides)] });
const mappedAnswers = (proof: string) => ({ "Runner?": "Vitest", "Proof?": proof });
const answered = (...proof: string[]) =>
  vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { question_1: ["Vitest"], question_2: proof },
  }));
const input = {
  questions: [
    question({ question: "Runner?", options: options("Vitest", "Node test") }),
    question({
      header: "Proof",
      question: "Proof?",
      options: options("Unit tests", "UI proof"),
      multiSelect: true,
    }),
  ],
};
const allowed = (proof: string) => ({
  behavior: "allow",
  updatedInput: { ...input, answers: mappedAnswers(proof) },
});
const displayedQuestions = (questions = input.questions) =>
  questions.map((entry, i) => ({ ...entry, id: `question_${i + 1}`, isOther: true }));
const withDescription = (description: string) => [
  { ...input.questions[0], options: [{ label: "Vitest", description }, ...options("Node test")] },
  input.questions[1],
];
const rejectedQuestions = (detail: string) => ({
  behavior: "deny",
  message: `OpenClaw rejected malformed Claude user questions: ${detail}. Correct the invalid field and retry AskUserQuestion.`,
});
function ask(
  authorizer: ReturnType<typeof authorizerFor>,
  payload: Record<string, unknown> = input,
  toolUseId?: string,
) {
  return authorizer.authorize({ input: payload, toolUseId, signal: new AbortController().signal });
}
async function expectRejected(payload: Record<string, unknown>, detail: string) {
  const requestUserInput = vi.fn();
  expect(await ask(authorizerFor(requestUserInput), payload)).toEqual(rejectedQuestions(detail));
  expect(requestUserInput).not.toHaveBeenCalled();
}

describe("Claude CLI user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the CLI callbacks", async () => {
    const requestUserInput = answered("Unit tests", "UI proof");
    const authorizer = authorizerFor(requestUserInput);
    const signal = new AbortController().signal;

    const first = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });
    const second = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });

    await expect(first).resolves.toEqual(allowed("Unit tests, UI proof"));
    await expect(second).resolves.toEqual(await first);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput).toHaveBeenCalledWith({
      toolName: "AskUserQuestion",
      intro: "Claude needs input:",
      toolCallId: "claude-question-1",
      abortSignal: signal,
      questions: displayedQuestions(),
    });
  });

  it.each([
    ["an oversized description", "x".repeat(2_000), `${"x".repeat(1_023)}…`],
    ["a surrogate at the boundary", `${"x".repeat(1_022)}🌍 tail`, `${"x".repeat(1_022)}…`],
    ["the exact display limit", "x".repeat(1_024), "x".repeat(1_024)],
  ])("preserves the question set and answers with %s", async (_case, description, displayed) => {
    const requestUserInput = answered("Unit tests");
    const payload = { questions: withDescription(description) };

    const result = await ask(authorizerFor(requestUserInput), payload);

    expect(payload.questions[0]!.options[0]!.description).toBe(description);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput.mock.calls[0]![0].questions).toEqual(
      displayedQuestions(withDescription(displayed)),
    );
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { ...payload, answers: mappedAnswers("Unit tests") },
    });
  });

  it("returns actionable denial guidance when the operator skips", async () => {
    const authorizer = authorizerFor(async () => ({
      status: "cancelled",
      message: "The operator skipped this question.",
    }));

    await expect(ask(authorizer)).resolves.toEqual({
      behavior: "deny",
      message: "The operator skipped this question. Continue with your best judgment.",
    });
  });

  it("guides a malformed question retry without replaying the rejected call", async () => {
    const requestUserInput = answered("Unit tests");
    const authorizer = authorizerFor(requestUserInput);
    const rejected = rejectedQuestions("questions[0].header must be at most 12 characters");
    const invalid = malformed({ header: "Too long for Claude" });

    await expect(ask(authorizer, invalid, "rejected-question")).resolves.toEqual(rejected);
    await expect(ask(authorizer, input, "rejected-question")).resolves.toEqual(rejected);
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(ask(authorizer, input, "corrected-question")).resolves.toEqual(
      allowed("Unit tests"),
    );
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, "must be an array of 1 to 4 questions"],
    [
      ["A", "B", "C", "D", "E"].map((header) => question({ header })),
      "must be an array of 1 to 4 questions",
    ],
    [["not a question"], "[0] must be an object"],
  ] as const)("rejects invalid question lists: %j", async (questions, detail) => {
    await expectRejected({ questions }, `questions${detail.startsWith("[") ? "" : " "}${detail}`);
  });

  it.each([
    ["multiSelect", "no", "multiSelect must be a boolean"],
    ["options", options("A"), "options must be an array of 2 to 4 options"],
    [
      "options",
      [...options("A"), { label: "B", description: "" }],
      "options[1].description must not be empty",
    ],
    ["options", options("A".repeat(257), "B"), "options[0].label must be at most 256 characters"],
    ["question", "Q".repeat(4_097), "question must be at most 4096 characters"],
    [
      "options",
      validOptions.map(({ description }) => ({ description })),
      "options[0].label must be a string",
    ],
  ] as const)("reports invalid %s without echoing payload text", async (field, value, detail) => {
    await expectRejected(malformed({ [field]: value }), `questions[0].${detail}`);
  });
});
