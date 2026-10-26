import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type { CostUsageTotals, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator } from "./usage-aggregates.js";
import { createUsageCalendar, type UsageCalendar } from "./usage-calendar.js";
import { filterSessionsByQuery } from "./usage-query.js";
import type {
  SessionUsageEntry,
  SessionsUsageOverview,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "./usage-types.js";

const PAGE_SIZE = 50;

function visitHours(
  session: SessionUsageEntry,
  calendar: UsageCalendar,
  inclusive: boolean,
  visit: (hour: number, weekday: number, share: number) => boolean | void,
) {
  const start = session.usage?.firstActivity ?? session.updatedAt;
  const end = session.usage?.lastActivity ?? session.updatedAt;
  if (!start || !end) {
    return false;
  }
  const low = Math.min(start, end),
    high = Math.max(start, end);
  let cursor = low;
  while (cursor <= high) {
    const next = cursor === high ? cursor : Math.min(calendar.nextHour(cursor), high);
    const { hour, weekday } = calendar.at(cursor);
    if (visit(hour, weekday, low === high ? 1 : (next - cursor) / (high - low)) === false) {
      break;
    }
    if (cursor === high || (!inclusive && next === high)) {
      break;
    }
    cursor = next;
  }
  return true;
}

type SessionHours = {
  tokens: ArrayLike<number>;
  weekdayTokens: ArrayLike<number>;
  /** Hour-level activity: tokens per hour are positive only where quarters had tokens. */
  precise: boolean;
  messages?: { total: ArrayLike<number>; errors: ArrayLike<number> };
};

// Filtering and chart folding read the same profile; detail rows map UTC quarters once per calendar.
const hourProfiles = new WeakMap<UsageCalendar, WeakMap<object, SessionHours>>();
// Report-local hours already follow the request calendar; their views are reused across reads.
const localProfiles = new WeakMap<object, SessionHours>();

/** Worker-folded rows carry report-calendar hours; detail rows still carry UTC quarters. */
function sessionHours(
  usage: NonNullable<SessionUsageEntry["usage"]>,
  calendar: UsageCalendar,
): SessionHours {
  if (usage.localHours) {
    const cached = localProfiles.get(usage.localHours);
    if (cached) {
      return cached;
    }
    const { values, precise } = usage.localHours;
    const hours = {
      tokens: values.subarray(0, 24),
      weekdayTokens: values.subarray(24, 31),
      precise,
      messages: { total: values.subarray(31, 55), errors: values.subarray(55, 79) },
    };
    localProfiles.set(usage.localHours, hours);
    return hours;
  }
  let profiles = hourProfiles.get(calendar);
  if (!profiles) {
    profiles = new WeakMap();
    hourProfiles.set(calendar, profiles);
  }
  const cached = profiles.get(usage);
  if (cached) {
    return cached;
  }
  const tokens = Array<number>(24).fill(0);
  const weekdayTokens = Array<number>(7).fill(0);
  const hours: SessionHours = { tokens, weekdayTokens, precise: false };
  for (const value of usage.utcQuarterHourTokenUsage ?? []) {
    if (value.totalTokens <= 0) {
      continue;
    }
    const mapped = calendar.quarter(value.date, value.quarterIndex);
    if (!mapped) {
      continue;
    }
    hours.precise = true;
    tokens[mapped.hour]! += value.totalTokens;
    weekdayTokens[mapped.weekday]! += value.totalTokens;
  }
  if (usage.utcQuarterHourMessageCounts?.length) {
    const total = Array<number>(24).fill(0);
    const errors = Array<number>(24).fill(0);
    for (const value of usage.utcQuarterHourMessageCounts) {
      const mapped = calendar.quarter(value.date, value.quarterIndex);
      if (!mapped) {
        continue;
      }
      total[mapped.hour]! += value.total;
      errors[mapped.hour]! += value.errors;
    }
    hours.messages = { total, errors };
  }
  profiles.set(usage, hours);
  return hours;
}

function touchesHours(session: SessionUsageEntry, hours: Set<number>, calendar: UsageCalendar) {
  if (hours.size === 0) {
    return true;
  }
  const profile = session.usage ? sessionHours(session.usage, calendar) : undefined;
  if (profile?.precise) {
    return [...hours].some((hour) => (profile.tokens[hour] ?? 0) > 0);
  }
  let touches = false;
  visitHours(session, calendar, true, (hour) => {
    touches = hours.has(hour);
    return !touches;
  });
  return touches;
}

function sessionRowTotals(session: SessionUsageEntry, days: ReadonlySet<string>): CostUsageTotals {
  const usage = session.usage;
  if (!days.size || !usage?.dailyBreakdown?.length) {
    return usage ?? createEmptyCostUsageTotals();
  }
  const totals = createEmptyCostUsageTotals();
  for (const day of usage.dailyBreakdown) {
    if (days.has(day.date)) {
      addCostUsageTotals(totals, { ...day, totalTokens: day.tokens, totalCost: day.cost });
    }
  }
  return totals;
}

function compareUsageOverviewSessions(options: UsageOverviewOptions) {
  if (options.recentKeys) {
    const recentKeys = options.recentKeys;
    return (a: SessionUsageEntry, b: SessionUsageEntry) =>
      recentKeys.indexOf(a.key) - recentKeys.indexOf(b.key);
  }
  const days = new Set(options.selectedDays);
  const rowTotals = new Map<SessionUsageEntry, ReturnType<typeof sessionRowTotals>>();
  const totals = (entry: SessionUsageEntry) => {
    let result = rowTotals.get(entry);
    if (!result) {
      result = sessionRowTotals(entry, days);
      rowTotals.set(entry, result);
    }
    return result;
  };
  const value = (entry: SessionUsageEntry) => {
    switch (options.sort) {
      case "tokens":
        return totals(entry).totalTokens;
      case "cost":
        return totals(entry).totalCost;
      case "messages":
        return entry.usage?.messageCounts?.total ?? 0;
      case "errors":
        return entry.usage?.messageCounts?.errors ?? 0;
      default:
        return entry.updatedAt ?? 0;
    }
  };
  const direction = options.sortDirection === "asc" ? -1 : 1;
  return (a: SessionUsageEntry, b: SessionUsageEntry) =>
    direction *
    (value(b) - value(a) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (a.label || a.key).localeCompare(b.label || b.key));
}

function compactSession(session: SessionUsageEntry, days: ReadonlySet<string>): SessionUsageEntry {
  if (!session.usage) {
    return session;
  }
  const row = sessionRowTotals(session, days);
  const usage = {
    ...session.usage,
    ...row,
    usageReport: row.usageReport,
  };
  for (const field of [
    "dailyBreakdown",
    "dailyMessageCounts",
    "dailyModelUsage",
    "dailyLatency",
    "utcQuarterHourTokenUsage",
    "utcQuarterHourMessageCounts",
    "localHours",
    "activityDates",
    "sessionFile",
  ] as const) {
    delete usage[field];
  }
  return { ...session, usage };
}

function selectUsageOverviewSessions(
  sessions: SessionUsageEntry[],
  options: UsageOverviewOptions,
  calendar: UsageCalendar,
) {
  const days = new Set(options.selectedDays);
  const hours = new Set(options.selectedHours);
  const queried = filterSessionsByQuery(
    sessions.filter((session) => touchesHours(session, hours, calendar)),
    options.query ?? "",
  );
  const matched = queried.sessions.filter(
    (session) =>
      !days.size ||
      (session.usage?.activityDates?.length
        ? session.usage.activityDates.some((day) => days.has(day))
        : Boolean(session.updatedAt && days.has(calendar.at(session.updatedAt).date))),
  );
  const selected = new Set(options.selectedSessions);
  const scoped = selected.size ? matched.filter((session) => selected.has(session.key)) : matched;
  const recent = options.recentKeys === undefined ? undefined : new Set(options.recentKeys);
  const roster = recent ? matched.filter((session) => recent.has(session.key)) : matched;
  return { days, queried, matched, selected, scoped, roster };
}

function usageOverviewPage(roster: SessionUsageEntry[], options: UsageOverviewOptions) {
  return roster
    .toSorted(compareUsageOverviewSessions(options))
    .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? PAGE_SIZE));
}

/** Selects rows for context hydration without calculating the full report twice. */
export function selectUsageOverviewPage(params: {
  rows: SessionUsageEntry[];
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
}): SessionUsageEntry[] {
  const { roster } = selectUsageOverviewSessions(
    params.rows,
    params.options,
    createUsageCalendar(params.dayBucket),
  );
  return usageOverviewPage(roster, params.options);
}

export function buildUsageOverview(params: {
  rows: SessionUsageEntry[];
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
  compact?: boolean;
}): UsageOverviewSlice {
  const { options, rows: sessions } = params;
  const calendar = createUsageCalendar(params.dayBucket);
  const filters = {
    agent: new Set<string>(),
    channel: new Set<string>(),
    provider: new Set<string>(),
    model: new Set<string>(),
    tool: new Set<string>(),
  };
  for (const session of sessions) {
    if (session.agentId) {
      filters.agent.add(session.agentId);
    }
    if (session.channel) {
      filters.channel.add(session.channel);
    }
    for (const provider of [
      session.modelProvider,
      session.providerOverride,
      session.origin?.provider,
    ]) {
      if (provider) {
        filters.provider.add(provider);
      }
    }
    if (session.model) {
      filters.model.add(session.model);
    }
    for (const model of session.usage?.modelUsage ?? []) {
      if (model.provider) {
        filters.provider.add(model.provider);
      }
      if (model.model) {
        filters.model.add(model.model);
      }
    }
    for (const tool of session.usage?.toolUsage?.tools ?? []) {
      filters.tool.add(tool.name);
    }
  }
  const { days, queried, matched, selected, scoped, roster } = selectUsageOverviewSessions(
    sessions,
    options,
    calendar,
  );
  const selectedSources = new Map(
    sessions
      .filter((session) => selected.has(session.key))
      .map((session) => [session.key, session]),
  );
  const selectedUsageComplete = selected.size
    ? selectedSources.size === selected.size &&
      [...selectedSources.values()].every(
        (session) =>
          session.usage &&
          !session.computing &&
          session.usage.staleSince === undefined &&
          !session.usage.refreshing,
      )
    : undefined;
  const selectedRows = new Map(
    selected.size ? scoped.map((session) => [session.key, session]) : [],
  );
  const toRow = (session: SessionUsageEntry) =>
    params.compact === false ? session : compactSession(session, days);
  const accumulator = createUsageAggregateAccumulator();
  const overview: SessionsUsageOverview = {
    total: roster.length,
    unfilteredSessionCount: sessions.length,
    selectedSessionCount: 0,
    selectedRowCount: scoped.length,
    selectedUsageComplete,
    selectedRows: [...selected].flatMap((key) => {
      const session = selectedRows.get(key);
      return session ? [toRow(session)] : [];
    }),
    tableSessionCount: matched.length,
    tableTotals: { tokens: 0, cost: 0, errors: 0 },
    offset: options.offset ?? 0,
    limit: options.limit ?? PAGE_SIZE,
    queryWarnings: queried.warnings,
    hourTokens: Array.from({ length: 24 }, () => 0),
    weekdayTokens: Array.from({ length: 7 }, () => 0),
    hasTimelineData: false,
    durationMs: 0,
    durationCount: 0,
    hourlyMessages: Array.from({ length: 24 }, () => 0),
    hourlyErrors: Array.from({ length: 24 }, () => 0),
    filterOptions: {
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      agent: [...filters.agent].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      channel: [...filters.channel].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      provider: [...filters.provider].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      model: [...filters.model].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      tool: [...filters.tool].sort(),
    },
  };
  for (const session of matched) {
    const row = sessionRowTotals(session, days);
    overview.tableTotals.tokens += row.totalTokens;
    overview.tableTotals.cost += row.totalCost;
    if (row.usageReport?.state === "unavailable") {
      overview.tableTotals.usageReport = row.usageReport;
    }
    overview.tableTotals.errors += session.usage?.messageCounts?.errors ?? 0;
  }
  for (const session of scoped) {
    accumulator.add(session);
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    if ((usage.durationMs ?? 0) > 0) {
      overview.durationMs += usage.durationMs!;
      overview.durationCount++;
    }
    const hours = sessionHours(usage, calendar);
    if (usage.totalTokens > 0) {
      if (hours.precise) {
        overview.hasTimelineData = true;
        for (let hour = 0; hour < 24; hour += 1) {
          overview.hourTokens[hour]! += hours.tokens[hour]!;
        }
        for (let weekday = 0; weekday < 7; weekday += 1) {
          overview.weekdayTokens[weekday]! += hours.weekdayTokens[weekday]!;
        }
      } else {
        overview.hasTimelineData =
          visitHours(session, calendar, false, (hour, weekday, share) => {
            overview.hourTokens[hour]! += usage.totalTokens * share;
            overview.weekdayTokens[weekday]! += usage.totalTokens * share;
          }) || overview.hasTimelineData;
      }
    }
    if (usage.messageCounts?.total) {
      if (hours.messages) {
        for (let hour = 0; hour < 24; hour += 1) {
          overview.hourlyMessages[hour]! += hours.messages.total[hour]!;
          overview.hourlyErrors[hour]! += hours.messages.errors[hour]!;
        }
      } else {
        visitHours(session, calendar, false, (hour, _weekday, share) => {
          overview.hourlyMessages[hour]! += usage.messageCounts!.total * share;
          overview.hourlyErrors[hour]! += usage.messageCounts!.errors * share;
        });
      }
    }
  }
  const totals = days.size ? accumulator.totalsForDays(days) : accumulator.totals;
  if (days.size) {
    // Only the calendar ignores its own day selection. Already accumulated rows
    // retain their totals and provider attribution without being processed twice.
    const accumulated = new Set(scoped);
    for (const session of queried.sessions) {
      if (!accumulated.has(session) && (!selected.size || selected.has(session.key))) {
        accumulator.addCalendar(session.usage);
      }
    }
  }
  overview.usageReport = accumulator.totals.usageReport;
  const aggregates = accumulator.finish();
  overview.selectedSessionCount = aggregates.sessionCount ?? 0;
  if (days.size) {
    for (const creator of aggregates.byCreator ?? []) {
      creator.daily = creator.daily.filter((day) => days.has(day.date));
      creator.totals = createEmptyCostUsageTotals();
      for (const day of creator.daily) {
        addCostUsageTotals(creator.totals, day);
      }
      creator.sessionCount = creator.sessionActivity.reduce(
        (count, activity) =>
          count + (activity.dates.some((day) => days.has(day)) ? activity.sessionCount : 0),
        0,
      );
    }
  }
  return {
    sessions: usageOverviewPage(roster, options).map(toRow),
    totals,
    aggregates,
    overview,
  };
}
