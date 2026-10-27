import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";
import { matchesStarSegments } from "../shared/star-pattern.js";
import { buildSafeToolName } from "./agent-bundle-mcp-names.js";
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
 * matches the probe name a tool gets before collision suffixes. When several
 * advertised tools share that name, include selects none of them and exclude
 * hides all of them. Suffixed probe names (`-2`) depend on which other tools
 * survive filtering, so they are not accepted; use raw names for those rare
 * collisions. Without a scope, matching is raw-only.
 */
export function createMcpToolFilter(
  toolFilter: McpServerToolFilterConfig | undefined,
  scope?: McpToolFilterScope,
): (toolName: string) => boolean {
  const rawNames = new Set(scope?.toolNames);
  const probeName = (toolName: string) =>
    scope
      ? buildSafeToolName({
          serverName: scope.safeServerName,
          toolName,
          reservedNames: new Set(),
        })
      : undefined;
  // Projected collisions are case-insensitive.
  const probeNameCounts = new Map<string, number>();
  for (const toolName of rawNames) {
    const key = normalizeLowercaseStringOrEmpty(probeName(toolName));
    probeNameCounts.set(key, (probeNameCounts.get(key) ?? 0) + 1);
  }
  return (toolName) => {
    const projected = probeName(toolName);
    const ambiguous = (probeNameCounts.get(normalizeLowercaseStringOrEmpty(projected)) ?? 0) > 1;
    const matches = (pattern: string, allowAmbiguous: boolean) => {
      if (matchesMcpToolFilterPattern(pattern, toolName)) {
        return true;
      }
      const trimmed = pattern.trim();
      return projected === trimmed && !rawNames.has(trimmed) && (allowAmbiguous || !ambiguous);
    };
    return (
      (!toolFilter?.include?.length ||
        toolFilter.include.some((pattern) => matches(pattern, false))) &&
      !toolFilter?.exclude?.some((pattern) => matches(pattern, true))
    );
  };
}
