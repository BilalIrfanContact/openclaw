import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { openFixtureReceiptChannel } from "../../test/helpers/fixture-receipts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logger from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { writeListToolsMcpServer } from "./agent-bundle-mcp-stdio.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: Awaited<ReturnType<typeof openFixtureReceiptChannel>>;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

it.each([
  {
    policy: "raw globs and names copied from probe",
    serverName: "docs",
    tools: ["query", "list_tables", "read_docs", "search_docs", "admin_delete"],
    toolFilter: {
      include: ["docs__query", "docs__list_tables", "docs__resources_list", "*_docs", "admin_*"],
      exclude: ["search_*", "docs__admin_delete"],
    },
    expectedTools: ["list_tables", "query", "read_docs"],
    expectedServer: { toolCount: 3, tools: { filteredCount: 2 } },
    expectedMaterialized: [
      ["docs__list_tables", "list_tables"],
      ["docs__query", "query"],
      ["docs__read_docs", "read_docs"],
      ["docs__resources_list", "resources_list"],
    ],
  },
  {
    policy: "session denials including synthetic tools",
    serverName: "docs",
    tools: ["search_docs", "read_docs"],
    toolOverrides: { mcpToolsDeny: { docs: ["read_docs", "resources_read"] } },
    expectedTools: ["search_docs"],
    expectedServer: { toolCount: 1 },
    expectedDenied: [{ serverName: "docs", toolName: "read_docs", deniedBySession: true }],
    expectedMaterialized: [
      ["docs__resources_list", "resources_list"],
      ["docs__search_docs", "search_docs"],
    ],
  },
  {
    policy: "own-property session denials",
    serverName: "constructor",
    tools: ["slow_tool"],
    toolOverrides: { mcpToolsDeny: { docs: ["slow_tool"] } },
    expectedTools: ["slow_tool"],
    expectedServer: { toolCount: 1 },
  },
])("filters the MCP catalog with $policy", async (row) => {
  const tempDir = tempDirs.make("bundle-mcp-tool-filter-");
  const [filePath, logPath] = [path.join(tempDir, "server.mjs"), path.join(tempDir, "server.log")];
  const tools = row.tools.map((name) => ({ name, inputSchema: { type: "object" } }));
  const capabilities = { tools: {}, resources: {} };
  await writeListToolsMcpServer({ filePath, logPath, capabilities, tools }, receipts.endpoint);
  const server = { command: process.execPath, args: [filePath], toolFilter: row.toolFilter };
  const runtime = createSessionMcpRuntime({
    sessionId: `tool-filter-${row.serverName}`,
    workspaceDir: tempDir,
    cfg: { plugins: { enabled: false }, mcp: { servers: { [row.serverName]: server } } },
    toolOverrides: row.toolOverrides,
  });
  onTestFinished(() => runtime.dispose());

  const catalog = await runtime.getCatalog();
  expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual(row.expectedTools);
  expect(catalog.servers[row.serverName]).toMatchObject(row.expectedServer);
  expect(catalog.sessionDeniedTools ?? []).toMatchObject(row.expectedDenied ?? []);
  if (!row.expectedMaterialized) {
    return;
  }
  const materialized = (await materializeBundleMcpToolsForRun({ runtime })).tools;
  expect(materialized.map((tool) => [tool.name, getPluginToolMeta(tool)?.mcp?.toolName])).toEqual(
    row.expectedMaterialized,
  );
  if (row.toolFilter) {
    // The upstream server, not the projected name, proves which operation runs.
    await materialized.find((tool) => tool.name === "docs__query")?.execute("call", {});
    expect((await fs.readFile(logPath, "utf8")).match(/^call .*$/gm)).toEqual(["call query"]);
  }
});

it.each([
  { include: ["resources_list"], warns: false },
  { include: ["nonexistent"], warns: true },
])("warns about an empty MCP include only when it selects nothing: $include", async (row) => {
  const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const tempDir = tempDirs.make("bundle-mcp-tool-filter-warn-");
  const [filePath, logPath] = [path.join(tempDir, "server.mjs"), path.join(tempDir, "server.log")];
  const tools = [{ name: "query", inputSchema: { type: "object" } }];
  const capabilities = { tools: {}, resources: {} };
  await writeListToolsMcpServer({ filePath, logPath, capabilities, tools }, receipts.endpoint);
  const server = {
    command: process.execPath,
    args: [filePath],
    toolFilter: { include: row.include },
  };
  const runtime = createSessionMcpRuntime({
    sessionId: "tool-filter-warn",
    workspaceDir: tempDir,
    cfg: { plugins: { enabled: false }, mcp: { servers: { docs: server } } },
  });
  onTestFinished(() => runtime.dispose());

  await runtime.getCatalog();
  const warned = warn.mock.calls.some(([message]) => String(message).includes("selected none"));
  expect(warned).toBe(row.warns);
});
