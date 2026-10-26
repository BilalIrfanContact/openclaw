import { expect, it } from "vitest";
import { resolveApprovalRequestKind, type ApprovalRequestInput } from "./approval-types.js";
import { buildPendingApprovalView } from "./approval-view-model.js";

const plugin = { title: "Use protected tool", description: "The plugin needs consent." };
function pending(request: ApprovalRequestInput["request"], id = "approval-id") {
  return buildPendingApprovalView({ id, createdAtMs: 1, expiresAtMs: 2, request });
}
function action(
  approvalId: string,
  approvalKind: "exec" | "plugin" | "system-agent",
  decision: "allow-once" | "deny",
) {
  return { type: "approval", approvalId, approvalKind, decision };
}

it("passes command analysis and external recipient scope through exec views", () => {
  const scope = {
    kind: "message-send" as const,
    target: "email",
    recipientCount: 3,
    recipients: ["alice@example.com", "bob@example.com"],
    audience: "external" as const,
  };
  const view = pending({
    command: "python -c 'print(1)'",
    host: "node",
    ask: "always",
    scope,
    commandAnalysis: {
      commandCount: 1,
      nestedCommandCount: 0,
      riskKinds: ["inline-eval"],
      warningLines: ["Contains inline-eval: python -c"],
    },
  });
  expect(view).toMatchObject({
    approvalKind: "exec",
    commandAnalysis: { warningLines: ["Contains inline-eval: python -c"] },
  });
  expect(view.scope).toEqual(scope);
  expect(view.metadata).toContainEqual({
    label: "Scope",
    value: "Send to 3 recipients via email (external): alice@example.com, bob@example.com, +1 more",
  });
  expect(view.actions[0]?.action).toEqual(action("approval-id", "exec", "allow-once"));
});

it("derives plugin ownership from payload and retains fail-closed decisions", () => {
  const scope = { kind: "external-post", target: "github", visibility: "public" } as const;
  const request = {
    id: "custom-id-without-prefix",
    createdAtMs: 1,
    expiresAtMs: 2,
    request: { ...plugin, scope, allowedDecisions: ["allow-once"] as const },
  };
  Object.defineProperty(request, "approvalKind", { value: "exec", enumerable: true });
  const view = buildPendingApprovalView(request);
  expect(view.approvalKind).toBe("plugin");
  expect(view.scope).toEqual(scope);
  expect(view.metadata).toContainEqual({ label: "Scope", value: "Post publicly to github" });
  expect(view.actions.map((descriptor) => descriptor.action)).toEqual([
    action(request.id, "plugin", "allow-once"),
    action(request.id, "plugin", "deny"),
  ]);
});

it("builds system-agent views with allow-once and deny only", () => {
  const description = "Rewrite the scheduler to prefer cooperative yields.";
  const view = pending(
    {
      title: "Apply proposed change",
      description,
      command: "rewrite scheduler",
      proposalHash: "hash-1",
      sessionId: "session-1",
      allowedDecisions: ["allow-once", "deny"],
    },
    "system-change-1",
  );
  expect(view).toMatchObject({ approvalKind: "system-agent", operationSummary: description });
  expect(view.actions.map((descriptor) => descriptor.action)).toEqual([
    action("system-change-1", "system-agent", "allow-once"),
    action("system-change-1", "system-agent", "deny"),
  ]);
});

it.each([
  [{ command: "echo safe" }, []],
  [plugin, [{ label: "Severity", value: "Warning" }]],
] as const)("preserves metadata without scope: %j", (request, metadata) => {
  const view = pending(request);
  expect(view.metadata).toEqual(metadata);
  expect(view).not.toHaveProperty("scope");
});

it.each([{}, { command: "echo hi", title: "Ambiguous", description: "Ambiguous" }])(
  "rejects payloads without exactly one owner: %j",
  (request) => {
    expect(() => resolveApprovalRequestKind({ request })).toThrow("exactly one owner");
  },
);
