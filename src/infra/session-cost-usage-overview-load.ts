import type { UsageOverviewSessionSummary } from "../shared/usage-types.js";
import type { UsageOverviewPackedUsage } from "./session-cost-usage-overview-report.js";
import { createSessionCostSummaryAccumulator } from "./session-cost-usage-rollup.js";
import type {
  UsageCostWorkerResult,
  UsageCostWorkerSession,
} from "./session-cost-usage-worker.types.js";

/** One agent's overview read, as the Gateway's session loader consumes it. */
export type UsageOverviewLoad = Omit<
  Extract<UsageCostWorkerResult, { kind: "overview" }>,
  "batch"
> & {
  /**
   * Quarter folds stay packed for the off-thread overview report; private sessions
   * keep in-memory summaries.
   */
  usage:
    | ({ kind: "packed" } & UsageOverviewPackedUsage)
    | { kind: "rows"; rows: Array<UsageOverviewSessionSummary | null> };
};

/** Overview rows from per-instance summaries (private sessions), one row per family. */
export function foldUsageOverviewFamilies(
  families: UsageCostWorkerSession[][],
  loaded: Pick<
    Extract<UsageCostWorkerResult, { kind: "sessions" }>,
    "summaries" | "cacheStatus" | "staleSessionFiles" | "invalidRows"
  >,
): UsageOverviewLoad {
  let offset = 0;
  const computing: boolean[] = [];
  const rows = families.map((family) => {
    const summaries = loaded.summaries.slice(offset, offset + family.length);
    offset += family.length;
    computing.push(summaries.some((summary) => summary === null));
    const present = summaries.filter((summary) => summary !== null);
    if (present.length <= 1) {
      return present[0] ?? null;
    }
    const usage = createSessionCostSummaryAccumulator(family[0]!);
    present.forEach((summary) => usage.add(summary));
    return usage.finish();
  });
  return {
    kind: "overview",
    usage: { kind: "rows", rows },
    computing,
    summarizing: loaded.cacheStatus.pendingFiles,
    cacheStatus: loaded.cacheStatus,
    staleSessionFiles: loaded.staleSessionFiles,
    invalidRows: loaded.invalidRows,
  };
}
