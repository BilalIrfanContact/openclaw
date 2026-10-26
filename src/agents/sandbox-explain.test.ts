import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ToolAllowDenyPolicyConfig } from "../config/types.tools.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import {
  formatSandboxToolPolicyBlockedMessage,
  resolvePreparedSandboxRuntimeStatus,
} from "./sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    // Audit logging is asserted without touching the real subsystem logger.
    info: toolPolicyAuditInfo,
  }),
}));

function sandboxConfig(
  tools: ToolAllowDenyPolicyConfig | undefined,
  agentTools?: ToolAllowDenyPolicyConfig,
  mode: "all" | "non-main" = "all",
): OpenClawConfig {
  const config: OpenClawConfig = {
    agents: {
      defaults: { sandbox: { mode, scope: "agent" } },
    },
    ...(tools === undefined ? {} : { tools: { sandbox: { tools } } }),
  };
  if (agentTools !== undefined) {
    config.agents!.entries = {
      work: { workspace: "~/openclaw-work", tools: { sandbox: { tools: agentTools } } },
    };
  }
  return config;
}

describe("sandbox explain helpers", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  it("prefers agent overrides > global > defaults (sandbox tool policy)", () => {
    const cfg = sandboxConfig({ allow: ["read"], deny: ["browser"] }, { allow: ["write"] });

    const resolved = resolveSandboxConfigForAgent(cfg, "work");
    expect(resolved.tools).toMatchObject({ allow: ["write", "view_image"], deny: ["browser"] });

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy).toMatchObject({
      allow: ["write", "view_image"],
      deny: ["browser"],
      sources: { allow: { source: "agent" }, deny: { source: "global" } },
    });
  });

  it("expands groups while preserving explicit denies", () => {
    const cfg = sandboxConfig({ deny: ["memory_get"] }, { allow: ["group:memory", "group:fs"] });

    const policy = resolveSandboxToolPolicyForAgent(cfg, "work");
    expect(policy.allow).toEqual([
      "memory_search",
      "memory_get",
      "personal_instructions",
      "ls",
      "read",
      "write",
      "edit",
      "apply_patch",
      "view_image",
    ]);
    expect(policy.deny).toEqual(["memory_get"]);
  });

  it.each([undefined, true])("explains non-main policy blocks (audit: %s)", (audit) => {
    const cfg = sandboxConfig({ deny: ["browser"] }, undefined, "non-main");
    const sessionKey = "agent:main:mobilechat:group:g1";
    const msg = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
        cfg,
        sessionKey,
        preparedSessionEntry: null,
      }),
      toolName: "browser",
      audit,
    });
    for (const text of [
      'Tool "browser" blocked by sandbox tool policy',
      "mode=non-main",
      "tools.sandbox.tools.deny",
      "agents.defaults.sandbox.mode=off",
      "Use the agent main session instead of a non-main session.",
    ]) {
      expect(msg).toContain(text);
    }
    if (!audit) {
      expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
      return;
    }
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
      {
        tool: "browser",
        ruleKind: "deny",
        ruleSource: "global",
        configKey: "tools.sandbox.tools.deny",
        matchedRule: "browser",
        sandboxMode: "non-main",
      },
    );
  });
});
