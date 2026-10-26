# Hotfix ledger management

Use `https://hotfix-ledger.openclaw.ai` as the recommended shared record for
hotfix candidates and release-specific backport assessments. These procedures
are part of the release skill; a separate `hotfix-ledger` skill is not required.
Keep the existing handoff and immutable release evidence for approvals, scan
bounds, and validation receipts. The ledger links that evidence rather than
replacing it or introducing another publication gate.

## Connect and find the release

Use the agent's existing managed secret-egress path with these protected bindings:

| Binding                                 | HTTPS header              |
| --------------------------------------- | ------------------------- |
| `HOTFIX_LEDGER_CF_ACCESS_CLIENT_ID`     | `CF-Access-Client-Id`     |
| `HOTFIX_LEDGER_CF_ACCESS_CLIENT_SECRET` | `CF-Access-Client-Secret` |

Send `Accept: application/json` and an identifying User-Agent such as
`OpenClaw-Release/1.0`. Keep credentials out of prompts, logs, and release evidence;
missing bindings are a reason to use the fallback, not to copy another agent's
secrets. Read authenticated `/v1/health`, `/v1/capabilities`, and the relevant
operations in `/v1/openapi.json` for current fields, enums, and permissions.

Find the target under `GET /v1/releases?repository=openclaw%2Fopenclaw` before
creating it. Match the intended release/branch, not just the channel. Create via
`POST /v1/releases` when absent, recording `releaseKey`, `name`, `channel`,
`versionLabel`, `gitRef`, and `observedHeadSha` alongside `repository` and
`state: active`. Reuse the record on resume; separate release versions should
remain distinguishable. The current API has beta/stable channels only: use
`stable` for extended-stable and identify its track in `releaseKey`, `name`,
and `gitRef`. This does not change its publication or eligibility rules.

## Recommended release flow

- **Discover:** load repository hotfixes and this release's assessments, including
  blocked carry-forward work. Reuse sibling-release evidence as a starting point,
  not a verdict for this baseline. Continue the existing pinned-main inventory,
  P0/P1 readiness review, and authorized security reconciliation. An empty ledger
  or an automated classification is not proof that discovery is complete.
- **Record:** look up a fix by `sourceUnitKey` and source references before creating
  it. Reuse its canonical identity across releases; describe an ordered companion
  group or squash scope explicitly. Record impact, severity, rationale, confidence,
  source PR/commit refs, dependencies, and eligibility. Newly discovered uncertain
  fixes can start as `needs_review`; automation nominations need the same review.
  The full scan inventory can stay in staging evidence, including unrelated commits.
- **Assess and select:** upsert the hotfix/release pair against the exact head being
  assessed. Record applicability, handling, dependencies, exclusions, adaptations,
  and supporting evidence. Use these records to present the proposed set, then
  record the owner's decisions and approval evidence. Eligibility and a clean
  applicability probe are recommendations, not inclusion authority.
- **Apply and verify:** follow the existing approved backport and validation flow.
  Record `destinationCommitRefs` and proof after applying a fix. Update the release's
  observed head as it changes and reassess affected decisions; `stale` assessments
  need review, not a timestamp/SHA-only rewrite to make them look current.
- **Finish or hand off:** retain included, deferred, and blocked decisions with
  final branch/version/SHA evidence so the next owner can continue. Prefer updating
  assessments over deleting history. Archive a release when it is no longer active,
  not simply because one candidate has been published.

The current assessment fields distinguish `applicability` (`unknown`, `needed`,
`already_present`, `not_affected`) from `handling` (`unknown`, `straightforward`,
`adaptation_required`, `blocked`). A deferred fix can still be needed and
straightforward; a fix skipped on one line may suit another. Put proposed,
approved, included, deferred, or skipped dispositions and their reasons in
`notes`, with evidence links. Do not mark a fix globally `not_a_hotfix` merely
because one release excludes it. P0/P1 priority is separate from API severity;
retain it in the rationale/evidence rather than inventing enum values.

## API mechanics

| Record     | Read/list                                 | Create or update                                                     |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Hotfix     | `/v1/hotfixes`, `/v1/hotfixes/{id}`       | POST collection; PATCH individual                                    |
| Release    | `/v1/releases`, `/v1/releases/{id}`       | POST collection; PATCH individual                                    |
| Assessment | `/v1/assessments`, `/v1/assessments/{id}` | PUT `/v1/releases/{releaseId}/hotfixes/{hotfixId}`; PATCH individual |

Follow list pagination: `{items, next}`, passing `after=next` until null;
`limit` is at most 100. Filter by repository and, for assessments, `releaseId`.
Use OpenAPI for additional filters and required create fields rather than
assuming the table is a complete request schema.

Mutations use `Content-Type: application/json`, `Idempotency-Key`, and
`X-Change-Reason`. PATCH uses the current `expectedRevision`; pair PUT uses 0
for creation or the current revision
for an update. Retain the exact body and key for an uncertain write: exact replay
returns its saved result. A 409 needs a fresh read and reconciliation, not a new
create or a blind overwrite. The verified identity supplies actor/assessor.
For routine diagnosis, use the authenticated audit and admin diagnostics endpoints.
Export, bulk operations, backup/restore, and permanent deletion are available
through the documented API for separately scoped maintenance, not release steps.

## When the ledger is unavailable

If credentials/access, service availability, or a required API capability prevent
use, note the limitation once and continue the existing local backport ledger and
handoff. Keep pending updates with that evidence; retry at a useful checkpoint
rather than polling or delaying publication. On recovery, read current records,
reconcile uncertain writes, and sync outstanding decisions without discarding
another owner's work. A validation error or revision conflict is normally something
to fix, not evidence that the service is down. This fallback concerns ledger
bookkeeping only; existing security reconciliation and release gates still apply.

## Private security evidence

Keep unpublished GHSA details, exploit notes, and private commit references in
the approved security record unless this ledger is explicitly approved for that
material and audience. Public release evidence should contain only the permitted
opaque pending/cleared status. Authenticated access is not disclosure permission;
a future public dashboard would need a deliberately sanitized view, not raw
records, exports, or audit events. Follow the API contract regardless of its
storage backend; no database migration is part of using this workflow.
