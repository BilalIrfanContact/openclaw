import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { gateway, settingsSelection, snapshot } from "./agents-page.test-support.ts";
import { page, type AgentsRouteData } from "./route.ts";

const agentsList: AgentsListResult = makeBootRoster({
  agents: [
    { id: "main", name: "Main" },
    { id: "ordinary-looking-id", kind: "system", name: "System" },
    { id: "research", name: "Research" },
  ],
});

function location(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

async function loadRoute(url: string, basePath = "") {
  const parsed = location(url);
  const request = vi.fn(async () => agentsList);
  const currentGateway = gateway(snapshot({ request } as unknown as GatewayBrowserClient));
  const agents = createAgentCapability(currentGateway);
  const context = {
    basePath,
    gateway: currentGateway,
    settingsAgentSelection: settingsSelection(null),
    agents,
  } as unknown as ApplicationContext;
  if (!page.loader) {
    throw new Error("agents route has no loader");
  }
  const result = (await page.loader(
    context,
    createRouteLoaderOptions(
      parsed,
      `${parsed.pathname}\u0000${parsed.search}\u0000${parsed.hash}`,
      "preload",
    ),
  )) as AgentsRouteData;
  expect(request).toHaveBeenCalledExactlyOnceWith("agents.list", {
    includeSessionPlacement: true,
  });
  expect(agents.state.agentsList).toBe(agentsList);
  agents.dispose();
  return {
    location: result.location,
    requestedAgentId: result.requestedAgentId,
    panel: result.panel,
    ...(result.canonicalLocation ? { canonicalLocation: result.canonicalLocation } : {}),
  };
}

async function expectRoute(
  suffix: string,
  requestedAgentId: string | null,
  panel: AgentsRouteData["panel"],
  canonicalSuffix?: string,
  basePath = "",
  restoredSuffix = suffix,
) {
  const url = (path: string) => `${basePath}/settings/agents${path}`;
  expect(await loadRoute(url(suffix), basePath)).toEqual({
    location: location(url(restoredSuffix)),
    requestedAgentId,
    panel,
    ...(canonicalSuffix !== undefined ? { canonicalLocation: location(url(canonicalSuffix)) } : {}),
  });
}

describe("agents route", () => {
  it.each([
    ["", null, "overview"],
    ["/research", "research", "overview"],
    ["/research/overview", "research", "overview"],
    ["/research/files", "research", "files"],
    ["/research/tools", "research", "tools"],
  ] as const)("reads %s without rewriting it", async (url, requestedAgentId, panel) => {
    await expectRoute(url, requestedAgentId, panel);
  });

  it.each([
    [
      "?agent=team.writer&probe=1#catalog",
      "team.writer",
      "overview",
      "/team%2Ewriter?probe=1#catalog",
    ],
    ["/research/tools?agent=main&probe=1", "research", "tools", "/research/tools?probe=1"],
    ["/research/unknown?probe=1#files", "research", "overview", "/research?probe=1#files", "/ui"],
    ["?agent=team%2Fwriter", null, "overview", ""],
    ["?agent=.", null, "overview", ""],
    ["?agent=..", null, "overview", ""],
  ] as const)(
    "canonicalizes %s while preserving URL state",
    async (url, agent, panel, canonical, base) => {
      await expectRoute(url, agent, panel, canonical, base);
    },
  );

  it("recovers the dynamic pathname without leaking the internal router parameter", async () => {
    await expectRoute(
      "?__openclawAgentPath=%2Fsettings%2Fagents%2Fresearch%2Fmemory&probe=1",
      "research",
      "memory",
      undefined,
      "",
      "/research/memory?probe=1",
    );
  });
});
