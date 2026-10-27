import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";
import { matchesStarSegments } from "../shared/star-pattern.js";
import { safeToolNameCandidate } from "./agent-bundle-mcp-names.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-types.js";

/** Match the documented MCP tool-filter glob syntax: exact text plus `*`. */
function matchesMcpToolFilterPattern(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }

  const parts = trimmed.split("*");
  return matchesStarSegments(
    {
      first: parts[0] ?? "",
      last: parts.at(-1) ?? "",
      interior: parts.slice(1, -1).filter(Boolean),
    },
    value,
  );
}

/** Normalizes open-world MCP tool filters into the runtime policy shape. */
export function normalizeMcpToolFilter(raw: unknown): McpServerToolFilterConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const include = filterStringEntries(raw.include);
  const exclude = filterStringEntries(raw.exclude);
  if (include.length === 0 && exclude.length === 0) {
    return undefined;
  }
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/**
 * One server's advertised tool names, which lets exact filter entries copied
 * from `openclaw mcp probe` (`<safeServerName>__<tool>`) select raw tools.
 */
export type McpToolFilterScope = {
  safeServerName: string;
  toolNames: readonly string[];
};

/** Reads a server's full advertised inventory, including filtered tools, from a catalog. */
export function mcpCatalogToolFilterScope(
  catalog: McpToolCatalog,
  serverName: string,
): McpToolFilterScope {
  const tools = catalog.policyTools ?? [...catalog.tools, ...(catalog.sessionDeniedTools ?? [])];
  return {
    safeServerName: catalog.servers[serverName]?.safeServerName ?? serverName,
    toolNames: tools.filter((tool) => tool.serverName === serverName).map((tool) => tool.toolName),
  };
}

/**
 * Builds the shared include-then-exclude policy for one server. Wildcards and
 * exact entries naming an advertised raw tool keep their raw meaning, so
 * existing filters select exactly what they did before. Any other exact entry
 * is read as a name copied from `openclaw mcp probe` and resolved to every
 * advertised tool materialization could allocate it to: the tool whose
 * unsuffixed name it is, plus any tool whose `-n` collision-suffixed name it
 * is. Include selects a tool only when it is the sole such owner and the
 * entry is its unsuffixed name; exclude hides every possible owner. Shared or
 * suffixed probe names therefore never select a different raw tool; use raw
 * names for those. Without a scope, matching is raw-only.
 */
export function createMcpToolFilter(
  toolFilter: McpServerToolFilterConfig | undefined,
  scope?: McpToolFilterScope,
): (toolName: string) => boolean {
  const rawNames = new Set(scope?.toolNames);
  const candidate = (toolName: string, attempt: number) =>
    safeToolNameCandidate({ serverName: scope?.safeServerName ?? "", toolName, attempt });
  const couldCarry = (toolName: string, entry: string) => {
    const suffixAttempt = Number(/-(\d+)$/.exec(entry)?.[1] ?? 1);
    return [1, suffixAttempt].some((attempt) => candidate(toolName, attempt) === entry);
  };
  const ownersByEntry = new Map<string, string[]>();
  const matchesProbeName = (entry: string, toolName: string, exclude: boolean) => {
    if (!scope || rawNames.has(entry) || !couldCarry(toolName, entry)) {
      return false;
    }
    if (exclude) {
      return true;
    }
    let owners = ownersByEntry.get(entry);
    if (!owners) {
      owners = [...rawNames].filter((name) => couldCarry(name, entry));
      ownersByEntry.set(entry, owners);
    }
    return owners.every((name) => name === toolName) && candidate(toolName, 1) === entry;
  };
  return (toolName) => {
    const matches = (pattern: string, exclude: boolean) =>
      matchesMcpToolFilterPattern(pattern, toolName) ||
      matchesProbeName(pattern.trim(), toolName, exclude);
    return (
      (!toolFilter?.include?.length ||
        toolFilter.include.some((pattern) => matches(pattern, false))) &&
      !toolFilter?.exclude?.some((pattern) => matches(pattern, true))
    );
  };
}
