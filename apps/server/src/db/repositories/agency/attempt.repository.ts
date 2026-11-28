/** `AgencyAttemptRepository`: call attempts — the dial lifecycle, dispositions, the attempts spines and the reaper reads. */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// The `23505` predicate, matched on the CONSTRAINT NAME. A leaf module (see its
// header) so the catch arms below can ask the question without dragging config
// into the graph of every test that exercises them.
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { createChildLogger } from '@magick-agency/observability';
import {
  AGENCY_ATTEMPT_LIVE_STATES,
  type AgencyCallAttemptRecord,
  type AgencyLapsedWrapupRow,
} from '../../models/agency.model.js';
// The supervisor read surface's cursor. `KEYSET_AT_SQL` is projected
// alongside every paged row so the cursor carries `created_at` at its true
// MICROSECOND precision — see that module for why a millisecond round-trip
// silently drops rows.
import { keysetAtSql, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import { withoutDates, type AgencyAttemptFilters } from '../../../agency/spine-filters.js';
import { PRIOR_ATTEMPT_LIMIT } from '@magick-agency/domain/retry-campaign-bounds';
import type { AgentAttemptFilters } from '../../../agency/agent-record.js';
import type {
  AgencyAbandonReason,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyAttemptRow,
  AgencyContactState,
  AgencyKeysetPage,
  AgencyOverrideKind,
} from '@magick-agency/contracts/agency';
import {
  attemptFilterConditions,
  inboundLogFilterConditions,
  keysetCondition,
  params,
  softphoneLogFilterConditions,
  toKeysetPage,
} from './query-builders.js';
import { attemptAgentUserSql } from './drilldown-sql.js';
import {
  projectAttemptRow,
  projectInboundLogRow,
  projectSoftphoneLogRow,
  type InboundLogRaw,
  type SoftphoneLogRaw,
} from './projections.js';
import type {
  CampaignCallLogRow,
  CampaignCallLogSourceFilter,
  CampaignCallSource,
  CampaignInboundLogRow,
} from '../../../agency/campaign-call-log.js';
import type { AgencyCallLogCounts, AgencyCallLogInboundOutcomeFilter } from '@magick-agency/contracts/api/agency/call-log';
import {
  AGENCY_CALL_EXPORT_ANALYSIS_FIELDS,
  AGENCY_CALL_EXPORT_KEY_PATTERN,
  type AgencyCallExportAnalysisFieldInfo,
} from '@magick-agency/contracts/api/agency/call-export-fields';
import {
  toCallExportCallFields,
  toCallExportDimensions,
  type CallExportFieldsRead,
  type CallExportLegAnalysis,
  type CallExportResult,
  type RawCallExportCallField,
  type RawCallExportDimension,
} from '../../../agency/call-export-fields.js';
import { inboundCampaignRowConditions, inboundMissedOpenSql } from './sql-fragments.js';
import { INBOUND_LOG_SELECT_SQL } from './inbound-log-sql.js';
import { SOFTPHONE_PLACED_SQL, softphoneStatusSql, type SoftphoneCallStatus } from './softphone-campaign-sql.js';
import { publishPacingInvalidation } from '../../../agency/pacing/invalidation-bus.js';
import { unclaimContactUncharged } from './contact-unclaim-sql.js';

/**
 * Tell pacing that live calls ENDED on these rows' accounts, so a campaign held at
 * its account limit ticks again at once (`pacing/invalidation-bus.ts`). Once per
 * account. Called after the autocommitted UPDATE returned, so the end is visible to
 * the count the woken tick runs.
 */
function announceCapacityFreed(rows: ReadonlyArray<{ tenant_id: string; account_id: string; state: string }>): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.state !== 'ended') continue;
    const key = `${row.tenant_id}:${row.account_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    publishPacingInvalidation({ type: 'account_capacity_freed', tenantId: row.tenant_id, accountId: row.account_id });
  }
}

const log = createChildLogger({ component: 'agency-repository' });

/**
 * The attempt-row projection the three attempt reads serve (`listForCampaign`,
 * `findForCampaign`, `listForAgent`), in the order {@link projectAttemptRow} reads
 * it. `a` is the attempt, `c` the contact, `s` the session (LEFT-joined on the
 * campaign spine, INNER on the agent's).
 */
const ATTEMPT_ROW_SELECT_SQL = `a.id, a.campaign_id, a.contact_id, a.attempt_number, c.phone_e164, a.caller_id,
             s.agent_user_id, a.reserved_agent_id, a.state, a.outcome,
             a.disposition_code, a.auto_disposition_code, a.notes, a.callback_at,
             a.promise_date::text AS promise_date, a.promise_amount,
             a.dispositioned_by_user_id, a.dispositioned_at, a.dispositioned_on_behalf,
             a.webrtc_call_id, a.dialed_at, a.answered_at, a.bridged_at, a.ended_at,
             a.talk_seconds, a.wrapup_seconds, a.redial_of_attempt_id, a.redial_number, a.created_at`;

/**
 * The contact join of every attempt read. `c.campaign_id = a.campaign_id` is
 * redundant for correctness and load-bearing for the plan — see
 * {@link AgencyAttemptRepository.listForCampaign}: both phone indexes are keyed
 * `(campaign_id, <expr>)`.
 */
const ATTEMPT_CONTACT_JOIN_SQL = `JOIN agency_contacts c
          ON c.id = a.contact_id AND c.campaign_id = a.campaign_id`;

/**
 * The campaign spine's WHERE terms (campaign, then every filter), shared by the page and its
 * opt-in total so the count is of exactly the rows the pages walk.
 *
 * The agent filter goes through the session (`attemptAgentUserSql`), because the attempt row
 * holds a SESSION id and a session id is meaningless to the person reading the page.
 */
function campaignAttemptConditions(
  campaignId: string,
  f: AgencyAttemptFilters,
  bind: ReturnType<typeof params>,
): string[] {
  return [
    `a.campaign_id = ${bind.add(campaignId)}`,
    ...attemptFilterConditions(f, bind, () => (f.agentUserId
      ? attemptAgentUserSql('a', bind.add(campaignId), bind.add(f.agentUserId))
      : null)),
  ];
}

/**
 * Whether a dialler attempt or a soft-phone call can match the What happened filter. With only
 * inbound happenings chosen (Missed, Voicemail, Abandoned) none can: those are things a caller
 * does to us. With an attempt outcome beside them, the attempt outcome is what they match on.
 */
function outboundMatches(f: AgencyAttemptFilters, inboundOutcomes: readonly string[]): boolean {
  return inboundOutcomes.length === 0 || Boolean(f.outcomes?.length);
}

/**
 * The call log's soft-phone facts as JSON (`extra`): the Missed inbound call the call rang back
 * (CL1) and when that call arrived, in the call's tenant; NULL when it is not a call back.
 */
const SOFTPHONE_LOG_EXTRA_SQL = `CASE WHEN m.callback_of_inbound_call_id IS NOT NULL THEN jsonb_build_object(
                 'callback_of', jsonb_build_object(
                   'inbound_call_id', m.callback_of_inbound_call_id,
                   'arrived_at', (SELECT cb.arrived_at FROM agency_inbound_calls cb
                                   WHERE cb.id = m.callback_of_inbound_call_id AND cb.tenant_id = m.tenant_id))) END`;

/** The leading terms of one campaign's inbound rows in the tenant (`idx_agency_inbound_calls_campaign`). */
function campaignInboundScopeTerms(campaignId: string, tenantId: string, bind: ReturnType<typeof params>): string[] {
  return [
    `i.campaign_id = ${bind.add(campaignId)}::uuid`,
    `i.tenant_id = ${bind.add(tenantId)}::uuid`,
  ];
}

/**
 * The WHERE terms of the call log's inbound rows, shared by the page, the counts and the Call
 * page's read so all three mean one thing by "an inbound call": `scopeTerms` first (whose calls:
 * a campaign's, filed under it in the tenant by `campaign_id`, 0069; or the account's), then
 * ENDED and served (never `rejected`), then the filters (`inboundLogFilterConditions`).
 * `toFollowUp` keeps the OPEN Missed rows (`inboundMissedOpenSql`, the Missed list's rule), drops
 * the dates (a caller still owed a call is owed it whatever day they rang), and reads the agent
 * filter as the row's ASSIGNEE: nobody answered a missed call, and "who still owes these" is
 * what that view is asked.
 */
function inboundLogConditions(
  scopeTerms: readonly string[],
  q: { filters: AgencyAttemptFilters; inboundOutcomes: readonly string[]; toFollowUp: boolean },
  bind: ReturnType<typeof params>,
): string[] {
  return [
    ...scopeTerms,
    // Ended and served, the rule the campaign's inbound figures share (`inboundCampaignRowConditions`).
    ...inboundCampaignRowConditions('i'),
    ...inboundLogFilterConditions(
      q.toFollowUp ? withoutDates(q.filters) : q.filters, q.inboundOutcomes, bind, q.toFollowUp ? 'assignee' : 'answerer',
    ),
    ...(q.toFollowUp ? [inboundMissedOpenSql('i')] : []),
  ];
}

/**
 * Whose calls a call-log read lists (`docs/call-log.md` §7): one campaign's (the campaign Call
 * log), the account's (All calls) or one agent's own in the account (My calls). The three are
 * the same read with a different term fixed, so a row means one thing on every list.
 *
 *  - `campaign`: the attempts of the campaign, the soft-phone calls tagged to it and the inbound
 *    calls filed under it, in the tenant.
 *  - `account`: every call of the account, or with `campaign: 'none'` the calls filed under
 *    none (no dialler call is: an attempt always has one). One campaign's calls at the account's
 *    scope are the `campaign` scope itself, once the caller has checked the campaign is the
 *    account's.
 *  - `agent`: the attempts of the agent's sessions in the account, the soft-phone calls they
 *    placed, the inbound calls they ANSWERED, and their OPEN Missed rows (assigned to them, the
 *    Missed list's own rule for an agent). Never anybody else's row. `campaign` narrows it to
 *    one campaign's, or to the calls filed under none. **A campaign named here must be one the
 *    caller has checked is the account's**: with it the dialler and answered-inbound branches
 *    are keyed on the campaign (its own indexes, as the campaign Call log's are) and carry no
 *    account term of their own.
 */
export type CallLogScope =
  | { kind: 'campaign'; campaignId: string; tenantId: string }
  | { kind: 'account'; tenantId: string; accountId: string; campaign?: 'none' }
  | { kind: 'agent'; tenantId: string; accountId: string; agentUserId: string; campaign?: string | 'none' };

/**
 * The attempts of agent USER `userParam` in the account: `reserved_agent_id` is one of their
 * sessions there (`attemptAgentUserSql`'s form and reasoning, without the campaign).
 */
function accountAgentAttemptSql(tenantParam: string, accountParam: string, userParam: string): string {
  return `a.reserved_agent_id = ANY(ARRAY(
           SELECT id FROM agency_agent_sessions
            WHERE agent_user_id = ${userParam}::uuid AND tenant_id = ${tenantParam}::uuid
              AND account_id = ${accountParam}::uuid))`;
}

/** When agent USER `userParam` first joined a session in the account; NULL (no row matches) when they never did. */
function accountAgentFirstSessionSql(tenantParam: string, accountParam: string, userParam: string): string {
  return `(SELECT min(joined_at) FROM agency_agent_sessions
            WHERE agent_user_id = ${userParam}::uuid AND tenant_id = ${tenantParam}::uuid
              AND account_id = ${accountParam}::uuid)`;
}

/**
 * The dialler branch's WHERE terms under a scope, or null when the scope holds no dialler call
 * (the calls filed under no campaign). At the account's and the agent's scope the attempt's own
 * `tenant_id` / `account_id` lead (`idx_agency_attempts_account_created`, 0072), and the agent
 * is a set of session ids, never a join condition.
 */
function scopedAttemptConditions(
  scope: CallLogScope,
  f: AgencyAttemptFilters,
  bind: ReturnType<typeof params>,
): string[] | null {
  if (scope.kind === 'campaign') return campaignAttemptConditions(scope.campaignId, f, bind);
  if (scope.campaign === 'none') return null;
  if (scope.kind === 'agent' && scope.campaign) {
    // One campaign's attempts by this agent: the campaign Call log's own agent filter
    // (`attemptAgentUserSql`: their sessions on the campaign), on the campaign's keyset index.
    return campaignAttemptConditions(scope.campaign, { ...f, agentUserId: scope.agentUserId }, bind);
  }
  const tenant = bind.add(scope.tenantId);
  const account = bind.add(scope.accountId);
  // An agent's own list is theirs whatever `agent_user_id` asks; the account's reads the filter.
  const agent = scope.kind === 'agent' ? scope.agentUserId : f.agentUserId;
  const user = agent ? bind.add(agent) : null;
  return [
    `a.tenant_id = ${tenant}::uuid`,
    `a.account_id = ${account}::uuid`,
    // No attempt of theirs is older than their first session here. Without the bound, somebody
    // who never dialled (a supervisor opening My calls) walks the account's whole range to find
    // nothing: measured 361 ms on 2 million attempts, against 0 with it.
    //
    // Why the bound cannot drop a row of theirs: `reserved_agent_id` is written once, by the two
    // INSERTs of this file (`create` and the redial), and no UPDATE sets it; it references
    // `agency_agent_sessions(id)`, so the session row was committed before the attempt was
    // inserted. Neither INSERT sets `created_at` (DEFAULT now()), and a session's `joined_at`
    // is DEFAULT now() at its INSERT and never written again: a rejoin reuses the row through an
    // upsert that leaves `joined_at`, `account_id` and `agent_user_id` alone (`upsertLiveSession`, and
    // `sql-fragments.ts` on the session events, which rests on the same fact). So an attempt's
    // `created_at` is at or after its own session's `joined_at`, which is at or after the
    // earliest of that agent's sessions in the account. Both clocks are the database's.
    ...(user ? [`a.created_at >= ${accountAgentFirstSessionSql(tenant, account, user)}`] : []),
    ...attemptFilterConditions(f, bind, () => (user ? accountAgentAttemptSql(tenant, account, user) : null)),
  ];
}

/** The campaign term of a soft-phone or inbound branch at the account's or an agent's scope. */
function scopedCampaignTerm(
  scope: Exclude<CallLogScope, { kind: 'campaign' }>,
  alias: 'm' | 'i',
  bind: ReturnType<typeof params>,
): string[] {
  if (scope.campaign === 'none') return [`${alias}.campaign_id IS NULL`];
  return scope.campaign ? [`${alias}.campaign_id = ${bind.add(scope.campaign)}::uuid`] : [];
}

/** The soft-phone branch's WHERE terms under a scope (the filters without the status and the keyset). */
function scopedSoftphoneConditions(
  scope: CallLogScope,
  f: AgencyAttemptFilters,
  bind: ReturnType<typeof params>,
): string[] {
  if (scope.kind === 'campaign') {
    return [
      `m.campaign_id = ${bind.add(scope.campaignId)}::uuid`,
      `m.tenant_id = ${bind.add(scope.tenantId)}::uuid`,
      ...softphoneLogFilterConditions(f, bind),
    ];
  }
  const { agentUserId: _asked, ...withoutAgent } = f;
  void _asked;
  return [
    `m.tenant_id = ${bind.add(scope.tenantId)}::uuid`,
    `m.account_id = ${bind.add(scope.accountId)}::uuid`,
    ...(scope.kind === 'agent' ? [`m.agent_user_id = ${bind.add(scope.agentUserId)}::uuid`] : []),
    ...scopedCampaignTerm(scope, 'm', bind),
    ...softphoneLogFilterConditions(scope.kind === 'agent' ? withoutAgent : f, bind),
  ];
}

/**
 * The inbound branches' WHERE terms under a scope: one set per branch. A campaign's and the
 * account's are one branch (`inboundLogConditions`' rule: ended, served, the filters; To follow
 * up the open Missed rows without the dates, its agent the assignee). An agent's are two, each
 * its own index range and never the same row twice (a missed call has no answerer): the calls
 * they answered, and their open Missed rows; To follow up keeps the second alone.
 */
function scopedInboundConditions(
  scope: CallLogScope,
  q: { filters: AgencyAttemptFilters; inboundOutcomes: readonly string[]; toFollowUp: boolean },
  bind: ReturnType<typeof params>,
): string[][] {
  if (scope.kind === 'campaign') {
    return [inboundLogConditions(campaignInboundScopeTerms(scope.campaignId, scope.tenantId, bind), q, bind)];
  }
  const accountTerms = (): string[] => [
    `i.tenant_id = ${bind.add(scope.tenantId)}::uuid`,
    `i.account_id = ${bind.add(scope.accountId)}::uuid`,
    ...scopedCampaignTerm(scope, 'i', bind),
  ];
  if (scope.kind === 'account') return [inboundLogConditions(accountTerms(), q, bind)];
  const base = (): string[] => [...accountTerms(), ...inboundCampaignRowConditions('i')];
  const filters = q.toFollowUp ? withoutDates(q.filters) : q.filters;
  const { agentUserId: _asked, ...mine } = filters;
  void _asked;
  const me = (): string => `${bind.add(scope.agentUserId)}::uuid`;
  const openMissed = [
    ...base(),
    `i.follow_up_assignee_user_id = ${me()}`,
    inboundMissedOpenSql('i'),
    ...inboundLogFilterConditions(mine, q.inboundOutcomes, bind),
  ];
  if (q.toFollowUp) return [openMissed];
  // The calls they answered. With a campaign, keyed on it alone (`idx_agency_inbound_calls_campaign`):
  // beside the account term the planner walks the account's whole range for a campaign and an
  // agent that share no call (measured 223 ms on 300,000 inbound calls, against the campaign's own
  // few thousand rows). The campaign is the account's (see `CallLogScope`).
  const answeredBase = scope.campaign && scope.campaign !== 'none'
    ? [...campaignInboundScopeTerms(scope.campaign, scope.tenantId, bind), ...inboundCampaignRowConditions('i')]
    : base();
  return [
    [...answeredBase, `i.answered_by_user_id = ${me()}`, ...inboundLogFilterConditions(mine, q.inboundOutcomes, bind)],
    openMissed,
  ];
}

/**
 * Whether a jsonb value would be a non-empty cell of the export: `callExportHasValue` in
 * `call-export-fields.ts` is the same rule in JS, and an integration test holds the two together.
 * Not NULL or JSON `null`, not `""`, and not a list none of whose items is a value: a list is
 * written as its items with a value joined (`[null]`, `["", null]` and `[]` are empty cells), and
 * an object or list inside it is written as JSON, so `[[]]` and `[{}]` are values. `value` is an
 * expression and may be repeated: pass a column or a cheap path.
 */
export function hasCellValueSql(value: string): string {
  return `(${value} IS NOT NULL AND ${value} <> 'null'::jsonb AND ${value} <> '""'::jsonb`
    + ` AND (jsonb_typeof(${value}) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(${value}) AS item(v)`
    + ` WHERE item.v <> 'null'::jsonb AND item.v <> '""'::jsonb)))`;
}

/**
 * What the export reads of a media leg's stored result (`CallExportResult` in
 * `call-export-fields.ts`), for the field list's `legs` and a page's extras lookup alike: never the
 * whole `call_analysis` (its turns, conversation quality and the rest are large). The result is
 * detoasted once per leg, by `jsonb_to_record` over its top-level keys
 * ({@link callExportResultJoinSql}), and each common field is taken current shape first, else
 * the legacy flat one. An erased leg (`deleted`), or one with no result object, has every column NULL.
 */
const CALL_EXPORT_RESULT_COLUMNS_SQL = `
  COALESCE(NULLIF(r.common -> 'summary', 'null'::jsonb), NULLIF(r.summary, 'null'::jsonb)) AS ai_summary,
  COALESCE(NULLIF(r.common #> '{overall_sentiment,label}', 'null'::jsonb),
           NULLIF(r.overall_sentiment -> 'label', 'null'::jsonb)) AS ai_sentiment,
  COALESCE(NULLIF(r.common #> '{overall_sentiment,score}', 'null'::jsonb),
           NULLIF(r.overall_sentiment -> 'score', 'null'::jsonb)) AS ai_sentiment_score,
  COALESCE(NULLIF(r.common -> 'key_topics', 'null'::jsonb), NULLIF(r.key_topics, 'null'::jsonb)) AS ai_key_topics,
  CASE WHEN jsonb_typeof(r.custom) = 'object' THEN r.custom END AS custom,
  CASE WHEN jsonb_typeof(r.custom_dimensions) = 'object' THEN r.custom_dimensions END AS custom_dimensions`;

/** The lateral `r` that {@link CALL_EXPORT_RESULT_COLUMNS_SQL} reads, over the `agency_calls` alias `leg`. */
function callExportResultJoinSql(leg: string): string {
  return `LEFT JOIN LATERAL jsonb_to_record(
           CASE WHEN ${leg}.analysis_status IS DISTINCT FROM 'deleted' AND jsonb_typeof(${leg}.call_analysis) = 'object'
                THEN ${leg}.call_analysis END
         ) AS r(common jsonb, summary jsonb, overall_sentiment jsonb, key_topics jsonb, custom jsonb, custom_dimensions jsonb)
      ON true`;
}

/**
 * The dimension copies the legs' analysis jobs ran with (CL45), as CTEs: `snapshots` (each job of
 * the calls `legIdsSql` yields as `call_id`, by its unique `call_id`, keeping only its dimension
 * copy, never the rest of its `profile_snapshot`), grouped by `versions` (a campaign's thousands
 * of calls share a handful), then `declared` (each key of each version that `keyCondition`
 * keeps, on `d.value`) and `dim_descriptions` (each key's newest description). Shared by the
 * field list and the preamble's descriptions.
 */
function dimensionDeclarationCtes(legIdsSql: string, keyCondition: string): string {
  return `snapshots AS MATERIALIZED (
        SELECT j.profile_snapshot -> 'custom_dimensions' AS dims, j.created_at
          FROM (${legIdsSql}) g
          JOIN dialer_analysis_jobs j ON j.call_id = g.call_id
      ),
      versions AS (
        SELECT dims, min(created_at) AS first_at, max(created_at) AS last_at
          FROM snapshots
         WHERE jsonb_typeof(dims) = 'array'
         GROUP BY 1
      ),
      declared AS (
        SELECT d.value ->> 'key' AS key, d.value ->> 'type' AS type, d.value ->> 'description' AS description,
               CASE WHEN jsonb_typeof(d.value -> 'options') = 'array' THEN d.value -> 'options' END AS options,
               v.first_at, v.last_at, d.pos
          FROM versions v
          CROSS JOIN LATERAL jsonb_array_elements(v.dims) WITH ORDINALITY AS d(value, pos)
         WHERE jsonb_typeof(d.value) = 'object' AND ${keyCondition}
      ),
      dim_descriptions AS (
        SELECT DISTINCT ON (key) key, description FROM declared
         WHERE description IS NOT NULL AND btrim(description) <> ''
         ORDER BY key, last_at DESC, first_at DESC, pos
      )`;
}

/** The calls a campaign call export reads: the Call log's own query, and the campaign's account. */
export interface CallExportListInput {
  campaignId: string;
  tenantId: string;
  accountId: string;
  filters: AgencyAttemptFilters;
  source: CampaignCallLogSourceFilter | null;
  softphoneStatus?: SoftphoneCallStatus;
  inboundOutcomes?: readonly AgencyCallLogInboundOutcomeFilter[];
}

/**
 * The listed rows of a campaign call export, as a UNION ALL of `(source, call_id, fields)`: the
 * list's branch rules (`listCallLog`), each branch reduced to what the field list reads, so the
 * set is exactly the rows the file would hold. Null when no branch can match.
 */
function callExportListedSql(input: CallExportListInput, bind: ReturnType<typeof params>): string | null {
  const scope: CallLogScope = { kind: 'campaign', campaignId: input.campaignId, tenantId: input.tenantId };
  const inboundOutcomes = input.inboundOutcomes ?? [];
  const outbound = outboundMatches(input.filters, inboundOutcomes);
  const branches: string[] = [];
  if ((input.source === null || input.source === 'dialler') && !input.softphoneStatus && outbound) {
    const conditions = scopedAttemptConditions(scope, input.filters, bind);
    if (conditions) {
      branches.push(`SELECT 'dialler'::text AS source, a.webrtc_call_id AS call_id, NULL::jsonb AS fields
         FROM agency_call_attempts a
         ${input.filters.phone ? ATTEMPT_CONTACT_JOIN_SQL : ''}
        WHERE ${conditions.join(' AND ')}`);
    }
  }
  if ((input.source === null || input.source === 'soft_phone') && outbound) {
    const conditions = scopedSoftphoneConditions(scope, input.filters, bind);
    if (input.softphoneStatus) conditions.push(softphoneStatusSql(input.softphoneStatus));
    branches.push(`SELECT 'soft_phone'::text AS source, m.webrtc_call_id AS call_id, m.fields
         FROM agency_manual_calls m
        WHERE ${conditions.join(' AND ')}`);
  }
  if ((input.source === null || input.source === 'inbound' || input.source === 'to_follow_up') && !input.softphoneStatus) {
    const sets = scopedInboundConditions(scope, {
      filters: input.filters, inboundOutcomes, toFollowUp: input.source === 'to_follow_up',
    }, bind);
    for (const conditions of sets) {
      branches.push(`SELECT 'inbound'::text AS source, i.webrtc_call_id AS call_id, NULL::jsonb AS fields
         FROM agency_inbound_calls i
        WHERE ${conditions.join(' AND ')}`);
    }
  }
  return branches.length > 0 ? branches.join('\n        UNION ALL\n        ') : null;
}

/** The analysis's common fields with their counts (`analysis_status` always has a value: every call). */
function analysisFieldInfos(counts: Record<string, number | string> | null, calls: number): AgencyCallExportAnalysisFieldInfo[] {
  return AGENCY_CALL_EXPORT_ANALYSIS_FIELDS.map((name) => ({
    name,
    calls: name === 'analysis_status' ? calls : Number(counts?.[name] ?? 0),
  }));
}

/** A row of the call log's union → its source's projection. */
function projectCallLogRow(row: AgencyCallAttemptRecord & {
  source: CampaignCallSource; phone_e164: string; agent_user_id: string | null;
}): CampaignCallLogRow {
  if (row.source === 'dialler') return { source: 'dialler', ...projectAttemptRow(row) };
  if (row.source === 'inbound') return projectInboundLogRow(row as unknown as InboundLogRaw);
  return projectSoftphoneLogRow(row as unknown as SoftphoneLogRaw);
}

export class AgencyAttemptRepository {
  /**
   * Create the attempt row for a claimed contact.
   *
   * Returns null when a unique index refuses it. The caller must treat null as
   * "someone else has this contact" and move on, never as an error to retry.
   *
   * ── `attempt_number` is DERIVED HERE, and never supplied by the caller ───────
   * It comes from `MAX(attempt_number)` over this contact's own attempt rows,
   * computed inside the INSERT. **The caller cannot pass it** — that is the point,
   * not an inconvenience.
   *
   * It used to be `contact.attempt_count + 1`, and that made a reaper-recovered
   * contact **permanently undialable for the life of the campaign**. `attempt_count`
   * was doing two unrelated jobs — retry-budget accounting *and* unique-number
   * generation — and they diverge the moment an attempt row exists that was never
   * counted. The reaper requeues without bumping the count (correctly: see below),
   * so the orphaned row already held the number the next derivation produced,
   * `uq_agency_attempt_number` is total rather than partial and does not care the
   * prior attempt ended, and the insert failed 23505 on every tick forever.
   *
   * **What made it invisible is worth remembering.** The contact went back to
   * `pending`, so nothing was stranded, no error surfaced, and the campaign was not
   * wedged — it simply never finished. The only signal was this method's own
   * `log.warn` about the duplicate-dial backstop, which is *exactly what a
   * correctly working backstop logs*. An operator reading it concluded the system
   * was protecting them. The two cases are now logged distinctly (below).
   *
   * Deriving from the attempts table instead separates the two concerns for good:
   * `attempt_count` stays purely the retry budget, and the number sequence stays
   * unique per contact across all history, which the retry policy reads.
   * Two concurrent inserts can still both read the same MAX — but that is now a
   * genuine, self-correcting race caught by the index and retried on the next tick,
   * rather than a permanent wedge, and `uq_agency_attempt_live` already makes two
   * live attempts per contact impossible.
   *
   * ── `bridge_grace_ms` is STAMPED HERE, from the campaign row, in the same statement ──
   * The abandonment grace this attempt will be judged by (0075, AG3) is the campaign's
   * `abandonment_grace_ms` as the INSERT reads it: never a value the caller passes, so no
   * dial path can stamp a stale or default grace, and a PATCH to the setting reaches the
   * very next attempt. The row it returns carries it, and the dial command takes it from
   * there (`DialCommand.bridgeGraceMs`), so the settle site's in-process twin judges the
   * call by the same number the table does. {@link beginWrapupRedial} stamps the same way.
   */
  async create(input: {
    campaignId: string;
    contactId: string;
    tenantId: string;
    accountId: string;
    callerId: string;
    reservedAgentId: string;
    /**
     * The agent's own dial of one of their contacts (`my-contact-call.ts`): `agent_manual`,
     * the overrides it spent and the calling-hours note. Absent on a paced dial (the column
     * defaults: `false`, `{}`, NULL).
     */
    agentManual?: { overrideApplied: readonly AgencyOverrideKind[]; overrideNote: string | null };
    /**
     * A paced dial (the pacing tick): consume the contact's pending reopen marker
     * (`agent_reopen_pending`, set by an agent's "Retry not reached") and stamp this attempt
     * `agent_reopened` when there was one, in this statement. So exactly the first paced
     * attempt after a reopen carries the flag.
     *
     * Race-safe without a lock of its own: the contact is `in_flight`, held by the tick's claim,
     * and a reopen only touches `pending` / `exhausted` rows under their row lock, so nothing
     * can set the marker between the claim and this insert. The marker's UPDATE is a CTE of the
     * INSERT, one statement: an insert refused by a unique index (null below) rolls the
     * consumption back with it. A contact with no marker writes nothing (no `updated_at` bump).
     */
    consumeAgentReopen?: boolean;
  }): Promise<AgencyCallAttemptRecord | null> {
    try {
      const { rows } = await getPool().query<AgencyCallAttemptRecord>(
        `WITH reopen AS (
           UPDATE agency_contacts
              SET agent_reopen_pending = false
            WHERE id = $2 AND agent_reopen_pending AND $10::boolean
           RETURNING id
         )
         INSERT INTO agency_call_attempts
           (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id, state,
            agent_manual, override_applied, override_note, agent_reopened, bridge_grace_ms)
         SELECT $1::uuid, $2, $3, $4,
                COALESCE(MAX(attempt_number), 0) + 1,
                $5, $6, 'queued',
                $7::boolean, $8::text[], $9::text,
                EXISTS (SELECT 1 FROM reopen),
                (SELECT c.abandonment_grace_ms FROM agency_campaigns c WHERE c.id = $1::uuid)
           FROM agency_call_attempts
          WHERE contact_id = $2
         RETURNING *`,
        [
          input.campaignId, input.contactId, input.tenantId, input.accountId,
          input.callerId, input.reservedAgentId,
          input.agentManual !== undefined, [...(input.agentManual?.overrideApplied ?? [])],
          input.agentManual?.overrideNote ?? null,
          input.consumeAgentReopen === true && input.agentManual === undefined,
        ],
      );
      return rows[0] ?? null;
    } catch (err) {
      // 23505 = unique_violation. Both indexes mean "move on", but they mean very
      // different things operationally and MUST NOT share a log line — that
      // conflation is what once hid the attempt-numbering wedge. A live-attempt refusal
      // is a correctness backstop doing its job and is expected under contention;
      // an attempt-number refusal is a lost race that should be vanishingly rare,
      // and a *steady stream* of them means numbers are colliding systematically.
      // Alert on the second, never on the first.
      if (isUniqueViolation(err)) {
        const constraint = (err as { constraint?: string }).constraint;
        if (isUniqueViolation(err, 'uq_agency_attempt_number')) {
          log.warn(
            { contactId: input.contactId, constraint },
            'Attempt-number collision — lost a concurrent insert race; retrying next tick',
          );
        } else {
          log.warn(
            { contactId: input.contactId, constraint },
            'Duplicate-dial backstop refused an attempt',
          );
        }
        return null;
      }
      throw err;
    }
  }

  /**
   * Start a wrap-up redial (`agency/wrapup-redial.ts`): in ONE transaction,
   *
   *  1. lock the attempt being redialled (`FOR UPDATE`) and require it still owes its
   *     write-up (`disposition_code IS NULL`);
   *  2. take the customer back: `connected → in_flight`, only while the contact is still
   *     parked for THIS attempt (no newer attempt on it, no soft-phone call holding it) —
   *     the same "still this attempt's" rule `closeLapsedWrapup` and
   *     `releaseFromDisposition` apply;
   *  3. close the redialled attempt's write-up with the reserved system code
   *     `redialed` (`AGENCY_REDIALED_DISPOSITION_CODE`), attributed to the agent. Its
   *     outcome is left as it is (`connected`): the call happened, and stats keep it;
   *  4. insert the redial attempt, linked back (`redial_of_attempt_id`) and numbered
   *     (`redial_number` = the redialled attempt's + 1), with `attempt_number` derived as
   *     {@link create} derives it, carrying the agent's notes so far, and stamped with the
   *     campaign's abandonment grace as it stands now (0075, AG3), as {@link create} stamps it:
   *     the redial is a new call to the customer, judged by today's setting.
   *
   * A disposition racing the redial meets the lock: whichever commits first wins, and
   * the other is refused (`disposition_already_submitted` here, `already_dispositioned`
   * on the disposition route). A double-clicked redial waits on the same lock and finds
   * the code stamped; `uq_agency_attempt_redial_of` is the backstop.
   *
   * Nothing is written on a refusal. The contact's `attempt_count` is not charged (a
   * redial continues one conversation; the retry budget is for new dials).
   */
  async beginWrapupRedial(input: {
    redialOfAttemptId: string;
    sessionId: string;
    actorUserId: string;
    callerId: string;
    disposition: string;
  }): Promise<
    | { ok: true; attempt: AgencyCallAttemptRecord }
    | { ok: false; reason: 'attempt_not_found' | 'disposition_already_submitted' | 'contact_not_held' | 'already_redialed' }
  > {
    try {
      return await withTransaction(async (client) => {
        const { rows: [original] } = await client.query<AgencyCallAttemptRecord>(
          'SELECT * FROM agency_call_attempts WHERE id = $1 FOR UPDATE',
          [input.redialOfAttemptId],
        );
        if (!original) return { ok: false, reason: 'attempt_not_found' } as const;
        if (original.disposition_code !== null) return { ok: false, reason: 'disposition_already_submitted' } as const;

        const claimed = await client.query(
          `UPDATE agency_contacts ct
              SET state = 'in_flight', updated_at = now()
            WHERE ct.id = $1
              AND ct.state = 'connected'
              AND NOT EXISTS (
                    SELECT 1 FROM agency_call_attempts n
                     WHERE n.contact_id = ct.id AND n.attempt_number > $2)
              AND NOT EXISTS (
                    SELECT 1 FROM agency_manual_calls m
                     WHERE m.contact_id = ct.id AND m.settled_at IS NULL AND m.contact_claimed)
          RETURNING ct.id`,
          [original.contact_id, original.attempt_number],
        );
        if (claimed.rowCount !== 1) {
          // Nothing written yet; `withTransaction` commits an empty transaction.
          return { ok: false, reason: 'contact_not_held' } as const;
        }

        await client.query(
          `UPDATE agency_call_attempts
              SET disposition_code = $2,
                  dispositioned_by_user_id = $3,
                  dispositioned_on_behalf = false,
                  dispositioned_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [original.id, input.disposition, input.actorUserId],
        );

        const { rows: [attempt] } = await client.query<AgencyCallAttemptRecord>(
          `INSERT INTO agency_call_attempts
             (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
              reserved_agent_id, state, redial_of_attempt_id, redial_number, notes, bridge_grace_ms)
           SELECT $1::uuid, $2, $3, $4,
                  COALESCE(MAX(attempt_number), 0) + 1,
                  $5, $6, 'queued', $7, $8, $9,
                  (SELECT c.abandonment_grace_ms FROM agency_campaigns c WHERE c.id = $1::uuid)
             FROM agency_call_attempts
            WHERE contact_id = $2
           RETURNING *`,
          [
            original.campaign_id, original.contact_id, original.tenant_id, original.account_id,
            input.callerId, input.sessionId, original.id, original.redial_number + 1,
            // The notes typed on the conversation so far travel with it: the outcome is
            // now written up on the redial, so that is where the agent's notes belong.
            // The redialled attempt keeps its copy (what was known when it ended).
            original.notes,
          ],
        );
        return { ok: true, attempt: attempt! } as const;
      }, { pool: getPool() });
    } catch (err) {
      // The transaction rolled back. The redial index: a second redial of one attempt
      // (unreachable past the lock above, kept as the backstop). Any other unique index
      // (a live attempt on the contact, an attempt-number race) means the contact was
      // not ours to redial after all.
      if (isUniqueViolation(err, 'uq_agency_attempt_redial_of')) return { ok: false, reason: 'already_redialed' };
      if (isUniqueViolation(err)) return { ok: false, reason: 'contact_not_held' };
      throw err;
    }
  }

  async setState(
    id: string,
    state: AgencyAttemptState,
    patch: {
      webrtc_call_id?: string | null;
      outcome?: AgencyAttemptOutcome | null;
      dialed_at?: Date;
      answered_at?: Date;
      bridged_at?: Date;
      ended_at?: Date;
      talk_seconds?: number;
      /** The wrap-up window owed on this attempt. Duration, not a
       *  deadline: with `ended_at` it says what was owed and from when, which is
       *  what lets the `no_disposition` sweep finish a wrap-up whose in-process
       *  timer died with its process. */
      wrapup_seconds?: number;
      /** When wrap-up actually began. Stamped by `WrapupManager`, deliberately never
       *  inferred from `ended_at` — two writers that agree today are still two
       *  writers. */
      wrapup_started_at?: Date;
      /** When wrap-up actually ended. */
      wrapup_ended_at?: Date;
      /** How it ended — a `WrapupResolution`. The column CHECKs the values, and
       *  `stats()`'s `avg_wrapup_seconds` averages only the ones that measure the
       *  work rather than an interruption. */
      wrapup_resolution?: string;
      /**
       * WHY this attempt reached no agent. Diagnosis only — the
       * compliance numerator keys on `ABANDONED_ATTEMPT_PREDICATE_SQL`, never on
       * this column, and NULL means "not an abandoned attempt" rather than
       * "cause unknown".
       */
      abandon_reason?: AgencyAbandonReason | null;
      /**
       * Advance `state` **only** if the row is currently one of these.
       *
       * The timestamp patch still lands either way — that is the whole point.
       * `answered` and `bridged` are emitted back-to-back by the bridge and their
       * handlers run concurrently (lifecycle listeners are invoked fire-and-forget),
       * so the two UPDATEs race and the loser wins the `state` column: a live,
       * bridged conversation could sit in the row as `answered` forever. Guarding
       * the whole statement instead would drop `answered_at` on that path, and
       * `answered_at` is the abandonment predicate's only input.
       *
       * Omit for an unconditional write — every caller that owns the transition
       * outright (dialing, ended, the sweeps) should.
       */
      only_from?: AgencyAttemptState[];
    } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = CASE
                        WHEN $11::text[] IS NULL OR state = ANY($11::text[]) THEN $2
                        ELSE state
                      END,
              webrtc_call_id = COALESCE($3, webrtc_call_id),
              outcome = COALESCE($4, outcome),
              dialed_at = COALESCE($5, dialed_at),
              answered_at = COALESCE($6, answered_at),
              bridged_at = COALESCE($7, bridged_at),
              ended_at = COALESCE($8, ended_at),
              talk_seconds = COALESCE($9, talk_seconds),
              wrapup_seconds = COALESCE($10, wrapup_seconds),
              wrapup_started_at = COALESCE($12, wrapup_started_at),
              wrapup_ended_at = COALESCE($13, wrapup_ended_at),
              wrapup_resolution = COALESCE($14, wrapup_resolution),
              abandon_reason = COALESCE($15, abandon_reason),
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [
        id, state, patch.webrtc_call_id ?? null, patch.outcome ?? null,
        patch.dialed_at ?? null, patch.answered_at ?? null, patch.bridged_at ?? null,
        patch.ended_at ?? null, patch.talk_seconds ?? null,
        patch.wrapup_seconds ?? null,
        patch.only_from ?? null,
        // Appended rather than slotted in beside the other timestamps: `$11` is
        // read as `$11::text[]` in the CASE above, so renumbering to keep the
        // parameters tidy would silently rebind the state guard.
        patch.wrapup_started_at ?? null,
        patch.wrapup_ended_at ?? null,
        patch.wrapup_resolution ?? null,
        patch.abandon_reason ?? null,
      ],
    );
    if (state === 'ended' && rows[0]) announceCapacityFreed(rows);
    return rows[0] ?? null;
  }

  /**
   * Record the media leg's id WITHOUT touching `state`.
   *
   * Separate from {@link setState} on purpose. The call id only exists once
   * `createBridgedCall` resolves, and by then the carrier may already have
   * answered — `onBridgeLifecycle` writes `bridged` from inside the dial. A
   * combined write would put `dialing` back over it and the row would read
   * `dialing` for the whole of a live conversation.
   *
   * A guarded "only if not already advanced" update would also close it, but this
   * removes the race rather than narrowing it: there is no state to lose, so no
   * ordering to get wrong. The attempt is already `dialing` from before the dial;
   * this write only ever had the id to contribute.
   */
  async attachWebrtcCall(attemptId: string, webrtcCallId: string): Promise<void> {
    await getPool().query(
      'UPDATE agency_call_attempts SET webrtc_call_id = $2, updated_at = now() WHERE id = $1',
      [attemptId, webrtcCallId],
    );
  }

  /**
   * Stamp the campaign's automatic outcome on an attempt that ended unanswered
   * (`auto_disposition_code`, decisions OD1–OD8). Returns whether it landed.
   *
   * Guarded, one statement: only on the ended attempt with the outcome the caller
   * resolved the code for, only while it has no automatic outcome yet (a replayed settle
   * cannot restamp it with a since-edited mapping: the code is what the campaign said when
   * the call ended, OD5). Never touches `disposition_code` or the contact.
   */
  async stampAutoDisposition(attemptId: string, outcome: AgencyAttemptOutcome, code: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE agency_call_attempts
          SET auto_disposition_code = $3, updated_at = now()
        WHERE id = $1 AND state = 'ended' AND outcome = $2 AND auto_disposition_code IS NULL`,
      [attemptId, outcome, code],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Settle a ringing dial its customer superseded by ringing in (the in-flight clash,
   * docs/inbound.md §5.4, IQ8), in ONE transaction:
   *
   *  1. the attempt `ended`, outcome `canceled`, with the reserved system code
   *     `inbound_call` (`AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE`, refused in every catalog)
   *     as its write-up, attributed to nobody: the customer's own call took it over, so no
   *     outcome is owed on it. Only while the row is not already `ended` (a second settle is a
   *     no-op and returns null);
   *  2. its contact back to `pending` now, UNCHARGED (`unclaimContactUncharged`, the statement
   *     `AgencyContactRepository.unclaimUncharged` runs, shared through `contact-unclaim-sql.ts`): neither
   *     `attempt_count` nor the our-fault ledger moves, and an agent's "Retry not reached"
   *     marker the dial consumed is restored. Only while the contact is still `in_flight`.
   *
   * The inbound call's own busy probe (`numberLiveSql`'s inbound arm) keeps pacing off the
   * number while the customer is on the line. Returns the ended row, or null when it was
   * already ended.
   */
  async endSupersededByInbound(input: {
    attemptId: string;
    contactId: string;
    code: string;
    talkSeconds: number | null;
  }): Promise<{ attempt: AgencyCallAttemptRecord; contactReturned: boolean } | null> {
    const out = await withTransaction(async (client) => {
      const { rows } = await client.query<AgencyCallAttemptRecord>(
        `UPDATE agency_call_attempts
            SET state = 'ended', outcome = 'canceled', ended_at = now(),
                talk_seconds = COALESCE($2::int, talk_seconds),
                disposition_code = $3, dispositioned_at = now(),
                updated_at = now()
          WHERE id = $1 AND state <> 'ended'
        RETURNING *`,
        [input.attemptId, input.talkSeconds, input.code],
      );
      const attempt = rows[0];
      if (!attempt) return null;
      const returned = await unclaimContactUncharged(client, input.contactId, attempt.agent_reopened === true);
      return { attempt, contactReturned: returned !== null };
    }, { pool: getPool() });
    if (out) announceCapacityFreed([out.attempt]);
    return out;
  }

  async findById(id: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'SELECT * FROM agency_call_attempts WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Record a disposition, idempotently on the code.
   *
   * **One guarded statement, and that is the whole design.** The predicate
   * `disposition_code IS NULL OR disposition_code = $2` makes first-write and
   * same-code replay the same successful path, and a different code a no-op that
   * writes nothing — atomically, so two submissions racing cannot interleave a
   * read with a write and let the second quietly overwrite the first. A
   * read-then-write in the route would look identical in every test and lose a
   * conversation record under a double-click.
   *
   * `null` therefore means one of exactly two things — no such attempt, or a
   * *different* code is already recorded — which the caller separates with a
   * follow-up read. That extra read only happens on the refusal path, so the
   * common case stays a single round trip.
   *
   * `notes` and `callback_at` are last-write-wins on a replay rather than
   * COALESCEd: an agent correcting their own note has to be able to shorten or
   * clear it, and COALESCE would make an empty string un-writable. The promise to pay
   * (`promise_date`, `promise_amount`, PT1) is last-write-wins for the same reason: a
   * same-code replay that corrects the date is an honest correction.
   */
  async recordDisposition(input: {
    attemptId: string;
    dispositionCode: string;
    notes: string | null;
    callbackAt: Date | null;
    actorUserId: string;
    onBehalf: boolean;
    /** `YYYY-MM-DD` and the amount's two-place string; absent or null: no promise. */
    promiseDate?: string | null;
    promiseAmount?: string | null;
  },
  /**
   * Run on the caller's client (decision B8) so the DNC route's optional disposition
   * commits or rolls back with its `dnc_entries` row. Omitted: the pool.
   */
  deps: { client?: Pick<PoolClient, 'query'> } = {},
  ): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await (deps.client ?? getPool()).query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET disposition_code = $2,
              notes = COALESCE($3, notes),
              callback_at = $4,
              dispositioned_by_user_id = $5,
              dispositioned_on_behalf = $6,
              promise_date = $7::date,
              promise_amount = $8::numeric,
              dispositioned_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (disposition_code IS NULL OR disposition_code = $2)
      RETURNING *`,
      [
        input.attemptId, input.dispositionCode, input.notes,
        input.callbackAt, input.actorUserId, input.onBehalf,
        input.promiseDate ?? null, input.promiseAmount ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  /**
   * Save notes without dispositioning. Last write wins; `''` clears.
   *
   * Deliberately separate from {@link recordDisposition} because the two happen
   * at different times: agents type while the customer is still talking, and a
   * call that ends before they pick a code must not discard what they wrote.
   */
  async saveNotes(attemptId: string, notes: string): Promise<AgencyCallAttemptRecord | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      'UPDATE agency_call_attempts SET notes = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [attemptId, notes],
    );
    return rows[0] ?? null;
  }

  /**
   * ALL non-terminal attempts, not just pre-answer ones. A bridged call still
   * holds an account concurrency slot, so excluding `answered`/`bridged` would
   * make the tick reserve agents and claim contacts only to be refused by the
   * guard, every tick, forever, whenever agents outnumber the account limit.
   */
  async countLive(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'",
      [campaignId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Live calls on the WHOLE ACCOUNT: the non-terminal attempts of every campaign
   * of `(tenantId, accountId)` plus the account's live soft-phone calls
   * (`agency_manual_calls`, `state <> 'ended'`). Pacing headroom subtracts this from
   * the account's concurrency (docs/softphone.md §4.1): a manual call holds a
   * carrier slot exactly like a campaign call, and it belongs to no campaign, so no
   * per-campaign count can see it. {@link countLive} stays per campaign.
   *
   * "Live" as {@link countLive} means it (every non-terminal state, bridged
   * included), spelled as its literal `state <> 'ended'`, byte for byte the predicate of
   * `idx_agency_attempts_account_live (tenant_id, account_id)` (0005), so the planner
   * can prove the partial index applies (a bound parameter cannot be). The attempt
   * half is keyed on the attempt's own `tenant_id` / `account_id` (NOT NULL, copied
   * from the campaign by {@link create}, the one INSERT), never on the account's
   * campaign set: that probed every campaign the account had ever had, per running
   * campaign, every tick. The manual half is served by `idx_agency_manual_calls_live`.
   *
   * An awaiting-outcome manual call (ended, unsettled) holds no slot and is not
   * counted.
   *
   * The third arm is the account's live ADMITTED inbound calls (`agency_inbound_calls` past
   * `arrived` and not `ended`: greeted, playing its message, waiting or connected), decision IB5:
   * a customer ringing in holds a line exactly like a call we placed, so outbound pacing shrinks
   * to make room (docs/inbound.md §5.3). A caller who was turned away (the route at its
   * `max_concurrent`, or the global or carrier scope full: `arrived`, never admitted or the
   * admission taken back, `refuseAdmission`) is neither waiting nor connected and holds no slot,
   * so it does not count while it hears "all lines are busy". Served by
   * `idx_agency_inbound_calls_account_live` (0026), whose predicate is this literal
   * (`state <> 'ended' AND state <> 'arrived'`, the route's admission count's too). A
   * tenant-default call (no account) is no account's.
   */
  async countLiveForAccount(tenantId: string, accountId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM agency_call_attempts a
           WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid AND a.state <> 'ended')
         +
         (SELECT COUNT(*) FROM agency_manual_calls m
           WHERE m.account_id = $2::uuid AND m.tenant_id = $1::uuid AND m.state <> 'ended')
         +
         (SELECT COUNT(*) FROM agency_inbound_calls i
           WHERE i.account_id = $2::uuid AND i.tenant_id = $1::uuid AND i.state <> 'ended' AND i.state <> 'arrived')
       )::text AS n`,
      [tenantId, accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The account's live attempts, per campaign: what the pacing round splits the account's
   * headroom by when two or more of its campaigns run (decisions MC1, MC2: each free slot
   * goes to the campaign with the fewest live calls). A campaign with none is absent from
   * the map. Read once per account per round, and only under contention, so a lone running
   * campaign issues no extra statement.
   *
   * The attempt half of {@link countLiveForAccount}, grouped: the same literal
   * `a.state <> 'ended'` keyed on the attempt's own `tenant_id` / `account_id`, so
   * `idx_agency_attempts_account_live` serves it. Soft-phone calls are no campaign's and
   * are not here; they still count against the account in {@link countLiveForAccount}.
   */
  async countLiveByCampaignForAccount(tenantId: string, accountId: string): Promise<Map<string, number>> {
    const { rows } = await getPool().query<{ campaign_id: string; n: string }>(
      `SELECT a.campaign_id, COUNT(*)::text AS n
         FROM agency_call_attempts a
        WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid AND a.state <> 'ended'
        GROUP BY a.campaign_id`,
      [tenantId, accountId],
    );
    return new Map(rows.map((r) => [r.campaign_id, Number(r.n)]));
  }

  /**
   * One campaign's attempts, newest first, keyset-paginated — the supervisor
   * read of the audit spine.
   *
   * ── What this must NOT be ───────────────────────────────────────────────────
   * A list of CALLS (`agency_calls`) cannot answer the question this route exists
   * for: being a CALL list, it structurally cannot show an attempt that never produced a call
   * — a `queued` attempt the reaper ended as `orphaned`, an `abandoned` one that
   * rang and found no agent, a `failed` dial. Those are precisely the rows a
   * compliance question is about.
   *
   * So the FROM clause is `agency_call_attempts`, and `agency_calls` is not
   * joined at all — not even to enrich. `webrtc_call_id` is emitted as an id for
   * the client to resolve separately, because it is deliberately
   * un-FK'd so the attempt row outlives a purged call, and any join to that table
   * would silently drop exactly the attempts whose history was purged.
   *
   * ── The agent join is LEFT, and that is not defensive ────────────────────────
   * `reserved_agent_id` is NULL on every attempt that failed before an agent was
   * on it, and `agency_agent_sessions` rows are per-shift. An inner join here
   * drops every never-reserved attempt — which is the "naive join drops the rows
   * you came for" trap in one line of SQL.
   *
   * The contact join is inner, and can be: `contact_id` is `NOT NULL REFERENCES
   * agency_contacts(id) ON DELETE CASCADE`, so an attempt without a contact row
   * cannot exist.
   *
   * ── The join carries `c.campaign_id = a.campaign_id`, and that is a PLAN fix ─
   * It is redundant for correctness — an attempt's contact is always on the
   * attempt's own campaign. It is load-bearing for the phone filter: both phone
   * indexes on `agency_contacts` are keyed `(campaign_id, <expr>)`, so without
   * it the leading column is unbound and neither can be used. A `?phone=`
   * filter then fell back to a **parallel sequential scan of the tenant's
   * contacts** — measured 153ms (exact) and 181ms (suffix) on 400k rows,
   * against 0.29ms with the predicate present. That is the sequential-scan shape
   * the reporting indexes exist to remove, reappearing on this route. Do not "simplify" it away.
   *
   * ── Plan ────────────────────────────────────────────────────────────────────
   * Driven by `idx_agency_attempts_keyset (campaign_id, created_at DESC,
   * id DESC)`. Every filter here is a predicate applied to rows
   * that index has already produced in order, so the `LIMIT` stops the scan
   * early instead of sorting the campaign.
   *
   * ⚠️ The `id` column is what makes it a keyset index. An index on
   * `(campaign_id, created_at DESC)` alone (the baseline's
   * `idx_agency_attempts_reporting`, dropped in migration 0003 as a strict prefix
   * of this one) cannot serve the row-wise `(created_at, id) < ($1, $2)`
   * comparison: Postgres degrades to reading the whole `created_at` tie group and
   * sorting it, on every page. Ties here are the normal case, because the attempt
   * batcher and roster ingest both insert inside one transaction where `now()` is
   * fixed.
   */
  async listForCampaign(input: {
    campaignId: string;
    filters: AgencyAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const bind = params();
    const conditions = campaignAttemptConditions(input.campaignId, input.filters, bind);
    if (input.after) conditions.push(keysetCondition(input.after, 'a', bind));

    const sql = `
      SELECT ${ATTEMPT_ROW_SELECT_SQL},
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        ${ATTEMPT_CONTACT_JOIN_SQL}
        LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${bind.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, bind.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * How many attempts {@link listForCampaign} would list with these filters, across every
   * page: the opt-in `total` (`?include_total=1`). The same WHERE terms
   * (`campaignAttemptConditions`), no keyset and no limit.
   *
   * The contact join is kept only when a filter reads the contact (`phone`); otherwise it
   * cannot change the count (`contact_id` is `NOT NULL REFERENCES agency_contacts`, and an
   * attempt's contact is on its campaign), and dropping it lets a dialled-window count be a
   * range scan of `idx_agency_attempts_campaign_dialed` alone.
   */
  async countListed(input: { campaignId: string; filters: AgencyAttemptFilters }): Promise<number> {
    const bind = params();
    const conditions = campaignAttemptConditions(input.campaignId, input.filters, bind);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM agency_call_attempts a
         ${input.filters.phone ? ATTEMPT_CONTACT_JOIN_SQL : ''}
        WHERE ${conditions.join(' AND ')}`,
      bind.values,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The campaign's call log (decisions SR6, CL11; `agency/campaign-call-log.ts`): its attempts,
   * as {@link listForCampaign} lists them, the soft-phone calls tagged to it and the inbound
   * calls filed under it in the tenant, newest first on ONE keyset `(created_at DESC, id DESC)`
   * across the three, so a page boundary neither drops nor repeats a row of any. An inbound
   * call's place in it is when it ARRIVED (`arrived_at`, served as `created_at`). `source`
   * limits it to one of the three, or to `to_follow_up`.
   *
   * One statement: each branch is its own keyset range with its own `LIMIT n + 1` (the
   * attempts on `idx_agency_attempts_campaign_created`, the tagged calls on
   * `idx_agency_manual_calls_campaign`, the inbound calls on `idx_agency_inbound_calls_campaign`),
   * and the outer sort takes the newest `n + 1` of the at most `3n + 3`. The filters mean on a
   * soft-phone call what they mean on an attempt (`softphoneLogFilterConditions`), and on an
   * inbound call what `inboundLogFilterConditions` says. An untagged soft-phone call belongs to
   * no campaign (SR4), as does an inbound call filed under none.
   *
   * ── A filter with no meaning on a type leaves that type out ────────────────
   * `softphoneStatus` (the Call log's Status filter) keeps the soft-phone calls in that status
   * (`softphoneStatusSql`); an attempt and an inbound call have no such status, so neither
   * matches. `inboundOutcomes` (Missed, Voicemail, Abandoned) are things only an inbound call
   * does: with one chosen and no attempt outcome beside it, no attempt and no soft-phone call
   * matches. The counts ({@link countCallLogForCampaign}) follow both.
   *
   * ── Inbound rows ────────────────────────────────────────────────────────────
   * Only ENDED calls (a live one is on Live calls, and has no outcome to list), and never a
   * `rejected` one (we turned it away unserved). `to_follow_up` is the campaign's OPEN Missed
   * rows (`inboundMissedOpenSql`, the Missed list's own rule) under the same filters WITHOUT
   * the dates (`from` / `to`): a caller owed a call back yesterday is still owed one today.
   */
  async listCallLogForCampaign(input: {
    campaignId: string;
    tenantId: string;
    filters: AgencyAttemptFilters;
    source: CampaignCallLogSourceFilter | null;
    softphoneStatus?: SoftphoneCallStatus;
    inboundOutcomes?: readonly AgencyCallLogInboundOutcomeFilter[];
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<CampaignCallLogRow>> {
    const { campaignId, tenantId, ...rest } = input;
    return this.listCallLog({ scope: { kind: 'campaign', campaignId, tenantId }, ...rest });
  }

  /**
   * {@link listCallLogForCampaign}'s read under any {@link CallLogScope}: the campaign Call log,
   * the account's All calls and the agent's My calls are this one statement with a different
   * term fixed (`docs/call-log.md` §7). The branches, the keyset, the filters' meaning on each
   * type and what an inbound row is are the same on all three.
   *
   * At the account's scope each branch is still its own index range: the attempts on
   * `idx_agency_attempts_account_created` (0072), the soft-phone calls on
   * `idx_agency_manual_calls_account`, the inbound calls on
   * `idx_agency_inbound_calls_account_arrived`. At an agent's, the soft-phone calls on
   * `idx_agency_manual_calls_agent`, the open Missed rows on
   * `idx_agency_inbound_calls_missed_assignee`; the attempts and the answered inbound calls are
   * the account's range filtered to the agent (their sessions; `answered_by_user_id`).
   */
  async listCallLog(input: {
    scope: CallLogScope;
    filters: AgencyAttemptFilters;
    source: CampaignCallLogSourceFilter | null;
    softphoneStatus?: SoftphoneCallStatus;
    inboundOutcomes?: readonly AgencyCallLogInboundOutcomeFilter[];
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<CampaignCallLogRow>> {
    const bind = params();
    const limit = bind.add(input.limit + 1);
    const inboundOutcomes = input.inboundOutcomes ?? [];
    const outbound = outboundMatches(input.filters, inboundOutcomes);
    const branches: string[] = [];
    if ((input.source === null || input.source === 'dialler') && !input.softphoneStatus && outbound) {
      const conditions = scopedAttemptConditions(input.scope, input.filters, bind);
      if (conditions) {
        if (input.after) conditions.push(keysetCondition(input.after, 'a', bind));
        branches.push(`(
        SELECT 'dialler'::text AS source, ${ATTEMPT_ROW_SELECT_SQL},
               false AS dnc_overridden, false AS hours_overridden, NULL::timestamptz AS settled_at,
               NULL::jsonb AS extra,
               ${keysetAtSql('a.created_at')} AS cursor_at
          FROM agency_call_attempts a
          ${ATTEMPT_CONTACT_JOIN_SQL}
          LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${limit})`);
      }
    }
    if ((input.source === null || input.source === 'soft_phone') && outbound) {
      const conditions = scopedSoftphoneConditions(input.scope, input.filters, bind);
      if (input.softphoneStatus) conditions.push(softphoneStatusSql(input.softphoneStatus));
      if (input.after) conditions.push(keysetCondition(input.after, 'm', bind));
      // Column for column with ATTEMPT_ROW_SELECT_SQL: NULL where the soft phone has no such thing.
      // Then the soft phone's own (overrides, settled, and under `extra` the missed call it rang
      // back), which the dialler branch fills with constants: the Call log's rows read them.
      branches.push(`(
        SELECT 'soft_phone'::text AS source, m.id, m.campaign_id, m.contact_id, NULL::int AS attempt_number,
               m.destination_e164 AS phone_e164, m.caller_id,
               m.agent_user_id, NULL::uuid AS reserved_agent_id, m.state, m.outcome,
               m.disposition_code, NULL::varchar AS auto_disposition_code, m.notes, m.callback_at,
               m.promise_date::text AS promise_date, m.promise_amount,
               m.dispositioned_by_user_id, m.dispositioned_at, m.dispositioned_on_behalf,
               m.webrtc_call_id, m.dialed_at, m.answered_at, m.bridged_at, m.ended_at,
               m.talk_seconds, NULL::int AS wrapup_seconds, NULL::uuid AS redial_of_attempt_id,
               NULL::int AS redial_number, m.created_at,
               (m.dnc_override_note IS NOT NULL) AS dnc_overridden,
               (m.hours_override_note IS NOT NULL) AS hours_overridden, m.settled_at,
               ${SOFTPHONE_LOG_EXTRA_SQL} AS extra,
               ${keysetAtSql('m.created_at')} AS cursor_at
          FROM agency_manual_calls m
         WHERE ${conditions.join(' AND ')}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${limit})`);
    }
    if ((input.source === null || input.source === 'inbound' || input.source === 'to_follow_up') && !input.softphoneStatus) {
      const sets = scopedInboundConditions(input.scope, {
        filters: input.filters,
        inboundOutcomes,
        toFollowUp: input.source === 'to_follow_up',
      }, bind);
      for (const conditions of sets) {
        if (input.after) conditions.push(keysetCondition(input.after, 'i', bind, 'arrived_at'));
        branches.push(`(
        SELECT ${INBOUND_LOG_SELECT_SQL},
               ${keysetAtSql('i.arrived_at')} AS cursor_at
          FROM agency_inbound_calls i
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.arrived_at DESC, i.id DESC
         LIMIT ${limit})`);
      }
    }
    // A filter no type left in the read can match (a status with `source: 'dialler'`, an
    // inbound-only outcome with `source: 'soft_phone'`): there is no branch to read.
    if (branches.length === 0) return { rows: [], next_cursor: null, limit: input.limit };
    const sql = `
      SELECT * FROM (${branches.join('\n        UNION ALL\n        ')}) log
       ORDER BY log.created_at DESC, log.id DESC
       LIMIT ${limit}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      source: CampaignCallSource; phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, bind.values);

    return toKeysetPage(rows, input.limit, projectCallLogRow);
  }

  /**
   * The Call log's chips (`docs/call-log.md`): how many rows of each source
   * {@link listCallLogForCampaign} would list with these filters, across every page, in one
   * statement. The same WHERE terms as the list's branches, no keyset, no limit and no
   * `source` (a chip says what choosing it would list).
   *
   * `dialler` is {@link countListed}'s count. `soft_phone` counts the tagged calls whose dial was
   * sent (`SOFTPHONE_PLACED_SQL`, the campaign figures' definition of a soft-phone call, SR2): a
   * row that failed before it dialled is listed, greyed, and is not a call. `inbound` counts
   * every inbound row listed; `all` is the three added. `to_follow_up` is the open Missed rows
   * under the filters without the dates, as the list's `to_follow_up` reads them; they are
   * inbound calls, so `all` does not take them a second time. A filter with no meaning on a
   * type counts none of that type (see {@link listCallLogForCampaign}).
   */
  async countCallLogForCampaign(input: {
    campaignId: string;
    tenantId: string;
    filters: AgencyAttemptFilters;
    softphoneStatus?: SoftphoneCallStatus;
    inboundOutcomes?: readonly AgencyCallLogInboundOutcomeFilter[];
  }): Promise<AgencyCallLogCounts> {
    const { campaignId, tenantId, ...rest } = input;
    return this.countCallLog({ scope: { kind: 'campaign', campaignId, tenantId }, ...rest });
  }

  /** {@link countCallLogForCampaign}'s counts under any {@link CallLogScope}, by {@link listCallLog}'s own WHERE terms. */
  async countCallLog(input: {
    scope: CallLogScope;
    filters: AgencyAttemptFilters;
    softphoneStatus?: SoftphoneCallStatus;
    inboundOutcomes?: readonly AgencyCallLogInboundOutcomeFilter[];
  }): Promise<AgencyCallLogCounts> {
    const bind = params();
    const inboundOutcomes = input.inboundOutcomes ?? [];
    const outbound = outboundMatches(input.filters, inboundOutcomes);
    const attempt = scopedAttemptConditions(input.scope, input.filters, bind) ?? ['FALSE'];
    if (input.softphoneStatus || !outbound) attempt.push('FALSE');
    const soft = [
      ...scopedSoftphoneConditions(input.scope, input.filters, bind),
      ...(input.softphoneStatus ? [softphoneStatusSql(input.softphoneStatus)] : []),
      ...(outbound ? [] : ['FALSE']),
      SOFTPHONE_PLACED_SQL,
    ];
    const q = { filters: input.filters, inboundOutcomes };
    const inbound = scopedInboundConditions(input.scope, { ...q, toFollowUp: false }, bind);
    const followUp = scopedInboundConditions(input.scope, { ...q, toFollowUp: true }, bind);
    if (input.softphoneStatus) for (const set of [...inbound, ...followUp]) set.push('FALSE');
    const inboundCountSql = (sets: string[][]): string => sets
      .map((set) => `(SELECT count(*) FROM agency_inbound_calls i WHERE ${set.join(' AND ')})`)
      .join(' + ');
    const { rows } = await getPool().query<{ dialler: string; soft_phone: string; inbound: string; to_follow_up: string }>(
      `SELECT (SELECT count(*)
                 FROM agency_call_attempts a
                 ${input.filters.phone ? ATTEMPT_CONTACT_JOIN_SQL : ''}
                WHERE ${attempt.join(' AND ')})::text AS dialler,
              (SELECT count(*)
                 FROM agency_manual_calls m
                WHERE ${soft.join(' AND ')})::text AS soft_phone,
              (${inboundCountSql(inbound)})::text AS inbound,
              (${inboundCountSql(followUp)})::text AS to_follow_up`,
      bind.values,
    );
    const dialler = Number(rows[0]?.dialler ?? 0);
    const softPhone = Number(rows[0]?.soft_phone ?? 0);
    const inboundCount = Number(rows[0]?.inbound ?? 0);
    return {
      all: dialler + softPhone + inboundCount,
      dialler,
      soft_phone: softPhone,
      inbound: inboundCount,
      to_follow_up: Number(rows[0]?.to_follow_up ?? 0),
    };
  }

  /**
   * What can be added to the campaign call export of the rows {@link listCallLogForCampaign}
   * would list with these filters and `source` (`docs/call-log.md` §10, CL45): how many there
   * are (every listed row, a soft-phone call that never dialled included, unlike the chips'
   * {@link countCallLog}), and, only with `includeAnalysis`, the analysis groups. Set-based, one
   * statement, by the list's own branch rules and WHERE builders, so the set is exactly the rows
   * the file would hold; no keyset, no limit.
   *
   *  - The media legs: each listed row's `webrtc_call_id` in `agency_calls` (its primary key),
   *    **scoped to the tenant AND the account** (the campaign's), so a leg of another account or
   *    tenant is never read, whatever id a row carries. An erased leg (`deleted`) has no result.
   *  - The dimensions (CL45): the union of the keys in the dimension copies each leg's analysis
   *    job ran with (`dialer_analysis_jobs.profile_snapshot -> 'custom_dimensions'`, by the
   *    unique `call_id`) and the keys in the stored results (`custom`, legacy `custom_dimensions`).
   *    The copies are grouped by version first (a campaign's thousands of calls share a handful),
   *    then per key: its types, oldest version first; a choice's options, first seen; the newest
   *    version's description; how many listed rows carry a value; on which call types.
   *  - The call details: the keys in the listed soft-phone rows' `fields` with a value, labelled
   *    from the account's soft-phone settings as they are now.
   *
   * A key that does not match `AGENCY_CALL_EXPORT_KEY_PATTERN` is not offered: the export could
   * not be asked for it. "A value" is what the file would write as a non-empty cell
   * ({@link hasCellValueSql}): not null, not `""`, not a list with no item that is a value.
   *
   * Every listed row is counted (`calls` is the true total, never capped). Of each leg only the
   * paths the fields read are carried (`legs`), and of each job only its dimension copy.
   */
  async callExportFieldsForCampaign(input: CallExportListInput & { includeAnalysis: boolean }): Promise<CallExportFieldsRead> {
    const bind = params();
    const listedSql = callExportListedSql(input, bind);
    if (listedSql === null) {
      return {
        calls: 0,
        analysis: input.includeAnalysis ? { analysed: 0, fields: analysisFieldInfos(null, 0), dimensions: [] } : null,
        call_fields: [],
      };
    }
    const tenant = `${bind.add(input.tenantId)}::uuid`;
    const account = `${bind.add(input.accountId)}::uuid`;
    const keyPattern = `${bind.add(AGENCY_CALL_EXPORT_KEY_PATTERN.source)}::text`;
    // `legs` carries only what is read of each result (`CALL_EXPORT_RESULT_COLUMNS_SQL`).
    const analysisCtes = input.includeAnalysis ? `,
      legs AS MATERIALIZED (
        SELECT l.source, c.id AS call_id, c.analysis_status, ${CALL_EXPORT_RESULT_COLUMNS_SQL}
          FROM listed l
          JOIN agency_calls c ON c.id = l.call_id
          ${callExportResultJoinSql('c')}
         WHERE l.call_id IS NOT NULL AND c.tenant_id = ${tenant} AND c.account_id = ${account}
      ),
      ${dimensionDeclarationCtes('SELECT DISTINCT call_id FROM legs', `(d.value ->> 'key') ~ ${keyPattern}`)},
      stored AS (
        SELECT g.source, k.key,
               COALESCE(NULLIF(g.custom -> k.key, 'null'::jsonb),
                        NULLIF(g.custom_dimensions -> k.key, 'null'::jsonb)) AS value
          FROM legs g
          CROSS JOIN LATERAL (
            SELECT jsonb_object_keys(COALESCE(g.custom, '{}'::jsonb))
            UNION
            SELECT jsonb_object_keys(COALESCE(g.custom_dimensions, '{}'::jsonb))
          ) AS k(key)
         WHERE k.key ~ ${keyPattern}
      ),
      dim_keys AS (SELECT key FROM declared UNION SELECT key FROM stored),
      dim_types AS (
        SELECT key, jsonb_agg(type ORDER BY first_seen, type) AS types
          FROM (SELECT key, type, min(first_at) AS first_seen FROM declared
                 WHERE type IN ('boolean', 'string', 'number', 'enum') GROUP BY key, type) t
         GROUP BY key
      ),
      dim_options AS (
        SELECT key, jsonb_agg(opt ORDER BY first_at, dpos, opos) AS options
          FROM (SELECT DISTINCT ON (d.key, o.opt) d.key, o.opt, d.first_at, d.pos AS dpos, o.pos AS opos
                  FROM declared d
                  CROSS JOIN LATERAL jsonb_array_elements_text(d.options) WITH ORDINALITY AS o(opt, pos)
                 WHERE d.type = 'enum' AND o.opt IS NOT NULL
                 ORDER BY d.key, o.opt, d.first_at, d.pos, o.pos) firsts
         GROUP BY key
      ),
      dim_calls AS (
        SELECT key, count(*) AS calls, array_agg(DISTINCT source) AS sources
          FROM stored WHERE ${hasCellValueSql('value')}
         GROUP BY key
      )` : '';
    const analysisColumns = input.includeAnalysis ? `,
      (SELECT jsonb_build_object(
                'analysed', count(*) FILTER (WHERE analysis_status = 'completed'),
                'ai_summary', count(*) FILTER (WHERE ${hasCellValueSql('ai_summary')}),
                'ai_sentiment', count(*) FILTER (WHERE ${hasCellValueSql('ai_sentiment')}),
                'ai_sentiment_score', count(*) FILTER (WHERE ${hasCellValueSql('ai_sentiment_score')}),
                'ai_key_topics', count(*) FILTER (WHERE ${hasCellValueSql('ai_key_topics')}))
         FROM legs) AS analysis,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'key', k.key, 'types', COALESCE(t.types, '[]'::jsonb), 'options', COALESCE(o.options, '[]'::jsonb),
                'description', ds.description, 'calls', COALESCE(dc.calls, 0), 'sources', COALESCE(to_jsonb(dc.sources), '[]'::jsonb))),
                '[]'::jsonb)
         FROM dim_keys k
         LEFT JOIN dim_types t ON t.key = k.key
         LEFT JOIN dim_options o ON o.key = k.key
         LEFT JOIN dim_descriptions ds ON ds.key = k.key
         LEFT JOIN dim_calls dc ON dc.key = k.key) AS dimensions` : '';
    const sql = `
      WITH listed AS MATERIALIZED (
        ${listedSql}
      )${analysisCtes},
      call_field_keys AS (
        SELECT f.key, count(*) AS calls
          FROM listed l
          CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(l.fields) = 'object' THEN l.fields ELSE '{}'::jsonb END) AS f(key, value)
         WHERE l.source = 'soft_phone' AND f.key ~ ${keyPattern} AND ${hasCellValueSql(`NULLIF(f.value, 'null'::jsonb)`)}
         GROUP BY f.key
      ),
      call_field_defs AS (
        SELECT DISTINCT ON (d.value ->> 'key') d.value ->> 'key' AS key, d.value ->> 'label' AS label, d.value ->> 'type' AS type
          FROM agency_softphone_settings s
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.call_fields) = 'array' THEN s.call_fields ELSE '[]'::jsonb END)
               WITH ORDINALITY AS d(value, pos)
         WHERE s.tenant_id = ${tenant} AND s.account_id = ${account} AND jsonb_typeof(d.value) = 'object'
         ORDER BY d.value ->> 'key', d.pos
      )
      SELECT (SELECT count(*) FROM listed)::int AS calls,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', k.key, 'calls', k.calls, 'label', d.label, 'type', d.type)), '[]'::jsonb)
                FROM call_field_keys k LEFT JOIN call_field_defs d ON d.key = k.key) AS call_fields${analysisColumns}`;

    const { rows } = await getPool().query<{
      calls: number;
      call_fields: RawCallExportCallField[];
      analysis?: Record<string, number | string>;
      dimensions?: RawCallExportDimension[];
    }>(sql, bind.values);
    const row = rows[0];
    const calls = Number(row?.calls ?? 0);
    return {
      calls,
      analysis: input.includeAnalysis
        ? {
          analysed: Number(row?.analysis?.['analysed'] ?? 0),
          fields: analysisFieldInfos(row?.analysis ?? null, calls),
          dimensions: toCallExportDimensions(row?.dimensions ?? []),
        }
        : null,
      call_fields: toCallExportCallFields(row?.call_fields ?? []),
    };
  }

  /**
   * The chosen dimensions' newest descriptions for the export's preamble (CL51), by key: the
   * field list's own `listed` rows and dimension CTEs, restricted to `keys`, and nothing else of
   * it: no result is read and nothing is counted. The legs are scoped to the tenant AND the
   * account, as in the field list. A key with no description (found only in stored results) is
   * absent.
   */
  async callExportDimensionDescriptions(input: CallExportListInput & { keys: readonly string[] }): Promise<Map<string, string>> {
    if (input.keys.length === 0) return new Map();
    const bind = params();
    const listedSql = callExportListedSql(input, bind);
    if (listedSql === null) return new Map();
    const tenant = `${bind.add(input.tenantId)}::uuid`;
    const account = `${bind.add(input.accountId)}::uuid`;
    const keys = `${bind.add([...input.keys])}::text[]`;
    const { rows } = await getPool().query<{ key: string; description: string }>(`
      WITH listed AS MATERIALIZED (
        ${listedSql}
      ),
      ${dimensionDeclarationCtes(
        `SELECT DISTINCT c.id AS call_id FROM listed l JOIN agency_calls c ON c.id = l.call_id
          WHERE l.call_id IS NOT NULL AND c.tenant_id = ${tenant} AND c.account_id = ${account}`,
        `(d.value ->> 'key') = ANY(${keys})`,
      )}
      SELECT key, description FROM dim_descriptions`, bind.values);
    return new Map(rows.map((r) => [r.key, r.description]));
  }

  /**
   * The export's extras for one page of the call log (`include=analysis`, CL47): each media leg's
   * analysis status and what the export reads of its stored result (`CALL_EXPORT_RESULT_COLUMNS_SQL`,
   * never the whole `call_analysis`), by primary key in ONE statement, **scoped to the tenant AND
   * the account** (the campaign's): a leg of another account or tenant is not read, whatever id a
   * row carries. An erased leg (`deleted`) answers its status and an empty result.
   * `withResult: false` (`include=analysis_status`, only `analysis_status` chosen) reads the
   * status alone (`result` null): no result is detoasted.
   */
  async callExportLegAnalyses(
    tenantId: string, accountId: string, callIds: readonly string[], opts: { withResult: boolean },
  ): Promise<Map<string, CallExportLegAnalysis>> {
    const ids = [...new Set(callIds)];
    if (ids.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; analysis_status: string | null } & Partial<CallExportResult>>(
      `SELECT c.id, c.analysis_status${opts.withResult ? `, ${CALL_EXPORT_RESULT_COLUMNS_SQL}` : ''}
         FROM agency_calls c
         ${opts.withResult ? callExportResultJoinSql('c') : ''}
        WHERE c.id = ANY($1::uuid[]) AND c.tenant_id = $2::uuid AND c.account_id = $3::uuid`,
      [ids, tenantId, accountId],
    );
    return new Map(rows.map((r) => [r.id, {
      analysis_status: r.analysis_status,
      result: opts.withResult
        ? {
          ai_summary: r.ai_summary ?? null,
          ai_sentiment: r.ai_sentiment ?? null,
          ai_sentiment_score: r.ai_sentiment_score ?? null,
          ai_key_topics: r.ai_key_topics ?? null,
          custom: r.custom ?? null,
          custom_dimensions: r.custom_dimensions ?? null,
        }
        : null,
    }]));
  }

  /**
   * The export's extras for one page (`include=call_fields`): the call details the agent entered
   * on each soft-phone call, by id in ONE statement, scoped to the tenant and the account.
   */
  async callExportCallFields(tenantId: string, accountId: string, manualCallIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const ids = [...new Set(manualCallIds)];
    if (ids.length === 0) return new Map();
    const { rows } = await getPool().query<{ id: string; fields: Record<string, unknown> }>(
      `SELECT id, fields FROM agency_manual_calls
        WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid AND account_id = $3::uuid`,
      [ids, tenantId, accountId],
    );
    return new Map(rows.map((r) => [r.id, r.fields]));
  }

  /**
   * One inbound call of the campaign, in the call log's own row (the list's SELECT and its
   * rule for what an inbound row is: ended, served, filed under this campaign in this tenant),
   * for its Call page. Null when it is not one, so an id from another campaign or tenant cannot
   * be substituted in the path.
   */
  async findInboundForCampaign(campaignId: string, tenantId: string, inboundCallId: string): Promise<CampaignInboundLogRow | null> {
    const bind = params();
    const conditions = inboundLogConditions(
      campaignInboundScopeTerms(campaignId, tenantId, bind), { filters: {}, inboundOutcomes: [], toFollowUp: false }, bind,
    );
    conditions.push(`i.id = ${bind.add(inboundCallId)}::uuid`);
    const { rows } = await getPool().query<InboundLogRaw>(
      `SELECT ${INBOUND_LOG_SELECT_SQL} FROM agency_inbound_calls i WHERE ${conditions.join(' AND ')}`,
      bind.values,
    );
    return rows[0] ? projectInboundLogRow(rows[0]) : null;
  }

  /**
   * One attempt, campaign-scoped, in the same shape the list serves.
   *
   * Campaign-scoped rather than by id alone, so the campaign's own ownership check
   * is what authorises the read: the route has already proved the caller owns the
   * campaign, and passing the campaign id here means an attempt id from a
   * different campaign — or a different tenant — cannot be substituted in the
   * path. Returning null for that case makes it a 404, which is also the honest
   * answer (that attempt is not on this campaign).
   *
   * Reuses `projectAttemptRow` and the list's projection deliberately: a detail
   * view whose fields drift from the list it was opened from is how a reader comes
   * to distrust both.
   */
  async findForCampaign(campaignId: string, attemptId: string): Promise<AgencyAttemptRow | null> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null;
    }>(
      `SELECT ${ATTEMPT_ROW_SELECT_SQL}
         FROM agency_call_attempts a
         ${ATTEMPT_CONTACT_JOIN_SQL}
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE a.id = $1 AND a.campaign_id = $2`,
      [attemptId, campaignId],
    );
    const row = rows[0];
    return row ? projectAttemptRow(row) : null;
  }

  /**
   * The agent-scoped attempt spine — one PERSON's dials, across every campaign.
   *
   * ── Why this cannot be a filter on `listForCampaign` ────────────────────────
   *
   * That method is campaign-scoped by construction: `campaign_id = $1` is its
   * first condition, its index is keyed on `campaign_id`, and its agent filter is
   * a subquery over the sessions of THAT campaign. An agent who works three
   * campaigns has three sessions and their record is spread across three of those
   * queries, which the caller would then have to merge and re-page by hand — and
   * a keyset cursor cannot be merged across result sets, because it names a
   * position in one ordering. Cross-campaign is a different read, so it is a
   * different method.
   *
   * ── The join is INNER on the session, which is the OPPOSITE of the campaign
   *    spine's LEFT — and both are right ───────────────────────────────────────
   *
   * There, LEFT is load-bearing: `reserved_agent_id` is NULL on every attempt
   * that failed before an agent was on it, and an inner join would drop exactly
   * those rows — the "naive join drops the rows you came for" trap. Here the
   * filter IS the agent, so an attempt with no reserved agent is not this
   * person's work by definition and the inner join is the predicate rather than
   * an accident of it. Note the consequence: this list can never show an attempt
   * that was never reserved, so it is not a substitute for the campaign spine
   * when the question is "what did we dial".
   *
   * ── The attempt points at a SESSION, not at a person ────────────────────────
   *
   * `reserved_agent_id` is an `agency_agent_sessions.id`, and
   * `agent_user_id` — the app's `users.id`, opaque to the dialer tables (no FK) —
   * lives on the session. Sessions are per shift, so one person's history is a set of session
   * ids that grows every day they work. That two-hop join is why an agent's own
   * record needs its own route rather than a query parameter.
   *
   * ── Plan, stated honestly ───────────────────────────────────────────────────
   *
   * The campaign spine is driven end-to-end by `idx_agency_attempts_keyset`
   * (campaign_id, created_at DESC, id DESC) — the ORDER BY comes free and the
   * LIMIT stops the scan. Nothing gives that here: the leading column of every
   * attempt index is either `campaign_id` or `reserved_agent_id`, and this query
   * filters on a SET of session ids and orders by `created_at`. So the planner
   * drives from the session join and sorts what it gathers.
   *
   * Not even `idx_agency_attempts_agent_dialed` — the index the
   * sibling `/stats` route exists on. It is partial (`WHERE dialed_at IS NOT
   * NULL`) and this query carries no predicate implying that, deliberately (see
   * the `created_at` bound below: an attempt that never dialled must still be
   * listed), so the planner cannot use it without dropping rows.
   *
   * That is accepted rather than indexed away, and the bound is what makes it
   * acceptable: the row set is one person's attempts, not a campaign's — a full
   * shift is hundreds of dials, a year is tens of thousands. The index that would
   * make this a single range scan is `(reserved_agent_id, created_at DESC, id
   * DESC)`, and it is deliberately NOT added: `agency_call_attempts` is written on
   * every dial, a fourth overlapping index taxes
   * that write path, and nobody has measured how deep anyone actually pages
   * this. Add it when a plan on production volume says so, not on this reasoning.
   */
  async listForAgent(input: {
    tenantId: string;
    accountId: string;
    agentUserId: string;
    filters: AgentAttemptFilters;
    after?: AgencyKeysetPosition;
    limit: number;
  }): Promise<AgencyKeysetPage<AgencyAttemptRow>> {
    const bind = params();
    const f = input.filters;
    // The PATH's agent, never `filters.agentUserId`. The query parameter is part
    // of the imported filter vocabulary and is ignored here on purpose — see
    // `parseAgentAttemptFilters`.
    //
    // ── The tenant/account scope is NOT optional, and it is on the SESSION ────
    //
    // `agent_user_id` is the app's `users.id` and is opaque here: the dialer
    // tables cannot tell whose it is, cannot tell a real one from a guess, and
    // this read has no route by which the caller proves they own it. Every other read on this surface is
    // scoped by resolving a CAMPAIGN the caller owns first (`requireOwned`); this
    // one has no campaign in its path, so the scope has to be a predicate. Without
    // it, any authenticated tenant could read any other tenant's agent by
    // supplying their user id — the whole cross-campaign history, phone numbers
    // and dispositions included.
    //
    // Scoped on the session rather than on the attempt because the session is what
    // makes the attempt this person's work; both rows are stamped from the same
    // campaign, so they cannot disagree.
    const conditions = [
      `s.agent_user_id = ${bind.add(input.agentUserId)}`,
      `s.tenant_id = ${bind.add(input.tenantId)}`,
      `s.account_id = ${bind.add(input.accountId)}`,
    ];

    if (f.campaignId) conditions.push(`a.campaign_id = ${bind.add(f.campaignId)}::uuid`);
    // The created_at bound inside is the opposite of the STATS endpoint, which
    // buckets on `dialed_at` precisely because it is aggregating dials rather than
    // listing attempts; the two are different questions and the divergence is
    // deliberate.
    conditions.push(...attemptFilterConditions(f, bind));
    if (input.after) conditions.push(keysetCondition(input.after, 'a', bind));

    const sql = `
      SELECT ${ATTEMPT_ROW_SELECT_SQL},
             ${keysetAtSql('a.created_at')} AS cursor_at
        FROM agency_call_attempts a
        ${ATTEMPT_CONTACT_JOIN_SQL}
        JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${bind.add(input.limit + 1)}`;

    const { rows } = await getPool().query<AgencyCallAttemptRecord & {
      phone_e164: string; agent_user_id: string | null; cursor_at: string;
    }>(sql, bind.values);

    return toKeysetPage(rows, input.limit, projectAttemptRow);
  }

  /**
   * Prior attempts on a contact's whole RETRY LINEAGE, newest first — the agent
   * panel's history block.
   *
   * ── This replaces a per-contact-row read, and the widening is the feature ──
   *
   * It used to be `WHERE contact_id = $1`, which is one campaign's worth of
   * history. Retry campaigns COPY contacts rather than sharing them (every
   * piece of per-campaign state lives on the row, and sharing one would make
   * `uq_agency_attempt_live` a cross-campaign lock), so "we called this person
   * twice last month" lives on a DIFFERENT row from the one being dialled now.
   * Keying on `root_contact_id` is what buys that history back, and the
   * denormalised root is what keeps it ONE indexed equality
   * instead of a recursive walk — see below for why that matters here
   * specifically.
   *
   * ── `ORDER BY` moved off `attempt_number`, and that is load-bearing ────────
   *
   * `attempt_number` is per contact ROW and **resets in every retry campaign**
   * (a retry is a fresh allowance, which is the point of authoring one).
   * Ordering by it interleaves two passes into nonsense: the parent's attempt 3
   * would sort above the child's attempt 1 even though the child's is more
   * recent. `ended_at DESC NULLS LAST` orders by when the dial actually finished,
   * and `NULLS LAST` keeps an attempt that never ended (reaped, orphaned) at the
   * bottom rather than at the top, where a NULL would otherwise sort first under
   * `DESC`. `attempt_number DESC` remains only as a deterministic tiebreaker for
   * two attempts that ended in the same microsecond.
   *
   * ── `campaign_name` joins the row because the agent needs it ───────────────
   *
   * "Attempt 2" means nothing once attempts come from two campaigns. The console
   * groups by campaign — this one first, then ancestors — which it cannot do from
   * an id it has no name for and no route to resolve.
   *
   * `c.campaign_id` is selected alongside `a.*` as the wire contract writes it;
   * the two hold the same value by construction (an attempt row carries the
   * campaign of its contact), and the join to `agency_contacts` is there for the
   * lineage predicate rather than for that column.
   *
   * ── ⚠️ THIS RUNS ON THE DIAL HOT PATH ─────────────────────────────────────
   *
   * `agency-dialer.ts#executeDial` calls it synchronously, BEFORE the dial, and
   * the pacing leader evaluates a campaign 4×/second. Three properties are not
   * negotiable and each has a test:
   *
   *   1. The caller's `try/catch` stays — history is nice-to-have and its absence
   *      must never cost the customer a call. A lineage query is a bigger thing
   *      to fail than a single-table read, which makes that guard more important
   *      rather than less.
   *   2. `PRIOR_ATTEMPT_LIMIT` stays. It is a display bound AND the bound on what
   *      this read can cost.
   *   3. Nothing may be added between the caller's `reserved` send and its dial.
   *
   * If this ever becomes slow enough to matter the answer is
   * `idx_agency_contacts_root` or dropping the campaign join —
   * never moving the send.
   *
   * @param rootContactId `agency_contacts.root_contact_id`, i.e. the head of the
   *   chain. Passing a plain `contact_id` for a contact that IS the head is the
   *   same value; passing it for a copied contact silently narrows the read to
   *   nothing, which is why the caller reads the column rather than reusing the id.
   */
  async findPriorForContactLineage(
    rootContactId: string,
    excludeAttemptId: string,
  ): Promise<Array<AgencyCallAttemptRecord & { campaign_name: string }>> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord & { campaign_name: string }>(
      `SELECT a.*, c.campaign_id, cam.name AS campaign_name
         FROM agency_call_attempts a
         JOIN agency_contacts  c   ON c.id  = a.contact_id
         JOIN agency_campaigns cam ON cam.id = c.campaign_id
        WHERE c.root_contact_id = $1 AND a.id <> $2
        ORDER BY a.ended_at DESC NULLS LAST, a.attempt_number DESC
        LIMIT ${PRIOR_ATTEMPT_LIMIT}`,
      [rootContactId, excludeAttemptId],
    );
    return rows;
  }

  /**
   * The **startup** reaper's sweep, and only that.
   *
   * ⚠️ **Do not call this from a running process.** The justification below holds
   * at boot and nowhere else: it is "any non-terminal attempt is dead *because
   * this process has just started and no other process could own it*", not "any
   * non-terminal attempt is dead". The periodic sweep was once found calling
   * this with an age cutoff, which quietly reinterpreted a boot-only argument as
   * a general one and reaped live conversations — see `sweepOnce` in
   * `src/agency/reaper.ts` for what that cost and what replaced it.
   *
   * The parameter is retained (and the only caller passes `null`) because
   * narrowing it away would silently change the startup semantics; a live sweep
   * wants {@link findNonTerminalOlderThan} + {@link reapByIds} instead, which can
   * exclude the attempts something still owns.
   *
   * Returns the reaped rows so their contacts can be returned to the roster.
   */
  async reapNonTerminal(olderThan: Date | null): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE state = ANY($1::varchar[])
          AND ($2::timestamptz IS NULL OR created_at < $2)
      RETURNING *`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    announceCapacityFreed(rows);
    return rows;
  }

  /**
   * Non-terminal attempts older than a cutoff — **candidates** for the periodic
   * sweep, not a verdict on any of them.
   *
   * Read-only on purpose. Deciding whether one of these is genuinely leaked needs
   * two liveness questions the database cannot answer — this replica's in-process
   * attempt map, and the Redis station-ownership key that says whether *some*
   * replica still holds the agent — so the decision cannot be a WHERE clause.
   */
  async findNonTerminalOlderThan(olderThan: Date): Promise<AgencyCallAttemptRecord[]> {
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `SELECT * FROM agency_call_attempts
        WHERE state = ANY($1::varchar[])
          AND created_at < $2
        ORDER BY created_at`,
      [AGENCY_ATTEMPT_LIVE_STATES as unknown as string[], olderThan],
    );
    return rows;
  }

  /**
   * Reap exactly these attempts, if they are *still* non-terminal.
   *
   * **The `state = ANY(live)` guard is the whole point and must not be dropped.**
   * It closes the window between the sweep's SELECT and this UPDATE: an attempt
   * that settled normally in between is already terminal, so this writes nothing
   * to it. Without the guard the sweep would overwrite a real outcome with
   * `orphaned` and return a contact whose call had in fact just connected —
   * the exactly-one-writer rule, enforced in SQL rather than hoped for.
   */
  async reapByIds(attemptIds: string[]): Promise<AgencyCallAttemptRecord[]> {
    if (attemptIds.length === 0) return [];
    const { rows } = await getPool().query<AgencyCallAttemptRecord>(
      `UPDATE agency_call_attempts
          SET state = 'ended', outcome = 'orphaned', ended_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND state = ANY($2::varchar[])
      RETURNING *`,
      [attemptIds, AGENCY_ATTEMPT_LIVE_STATES as unknown as string[]],
    );
    announceCapacityFreed(rows);
    return rows;
  }

  /**
   * Conversations whose wrap-up lapsed with nothing written up.
   *
   * Every clause is load-bearing:
   * - `state='ended'` + `outcome='connected'` + `bridged_at IS NOT NULL` — there
   *   was a real conversation. `bridged_at` rather than the outcome alone for the
   *   same reason `dispositionRefusal` keys on it: the outcome is a
   *   classification that can be absent or late, `bridged_at` is the instant
   *   media joined the two parties.
   * - `disposition_code IS NULL` — the agent did not write it up. A row that has
   *   one must never be revisited; that is a record of what was said to a
   *   customer.
   * - `contacts.state = 'connected'` — the contact is still parked waiting for
   *   that write-up. This is the actual harm being repaired, and joining on it
   *   means a contact some other path already released is left alone.
   * - the `ended_at + wrapup_seconds + grace` clock — `wrapup_seconds` is the
   *   window the campaign promised the agent, per row, because it is read off the
   *   attempt rather than off today's campaign config (an operator shortening it
   *   mid-shift must not retroactively expire wrap-ups that were owed longer).
   *
   * The campaign's `disposition_catalog` rides along because the caller must ask
   * `requiresDisposition` before stamping anything — a campaign that never owed a
   * disposition must not be given one.
   */
  async findLapsedWrapups(graceSeconds: number, limit = 500): Promise<AgencyLapsedWrapupRow[]> {
    const { rows } = await getPool().query<AgencyLapsedWrapupRow>(
      `SELECT a.*,
              c.disposition_catalog AS campaign_disposition_catalog,
              c.retry_policy        AS campaign_retry_policy,
              -- The contact's retry BUDGET, not the attempt's own
              -- attempt_number. The two are deliberately decoupled,
              -- and the policy is evaluated against the budget. This path does NOT
              -- bump it (the attempt was counted when it ended), so the stored value
              -- is already the post-attempt count the policy is defined on.
              ct.attempt_count      AS contact_attempt_count
         FROM agency_call_attempts a
         JOIN agency_contacts  ct ON ct.id = a.contact_id
         JOIN agency_campaigns  c ON c.id  = a.campaign_id
        WHERE a.state = 'ended'
          -- A conversation, or a wrap-up redial of one (which owes its outcome
          -- whatever its own; the sweep routes it as \`connected\`).
          AND ((a.outcome = 'connected' AND a.bridged_at IS NOT NULL) OR a.redial_number > 0)
          AND a.disposition_code IS NULL
          AND a.ended_at IS NOT NULL
          AND ct.state = 'connected'
          AND a.ended_at + make_interval(secs => COALESCE(a.wrapup_seconds, 0) + $1) < now()
        ORDER BY a.ended_at
        LIMIT $2`,
      [graceSeconds, limit],
    );
    return rows;
  }

  /**
   * Close one lapsed wrap-up that {@link findLapsedWrapups} returned: stamp the attempt's
   * auto-close code (when one is owed) and write its contact's release, **only while both
   * rows are still what that read found**. One statement, so the check and both writes
   * cannot be separated by anything else touching either row.
   *
   * ── Why the check ───────────────────────────────────────────────────────────
   *
   * The sweep reads, then writes, row by row. Between the two the contact can move on:
   * the agent's disposition releases it (a callback puts it back `pending`), pacing or a
   * soft-phone call claims it, a new conversation parks it `connected` again for its own
   * write-up, a DNC mark suppresses it. A release written regardless then pulled an
   * `in_flight` contact out from under its new live call, reopened or re-closed a contact
   * the new attempt had settled, and overwrote its `last_outcome` with the old one. The
   * same shape `AgencyContactRepository.requeueOrphaned` closes for the reaper's requeue.
   *
   * So both writes land only while, re-checked on the locked rows:
   *
   *  - the attempt is `ended` with no `disposition_code` (an agent who wrote it up in the
   *    meantime keeps their record; the sweep writes nothing, as before);
   *  - the contact is `connected` (still parked waiting for that write-up) and no attempt
   *    on it is newer than this one (`attempt_number` is MAX + 1 per contact, so a
   *    contact parked `connected` by a LATER call is not this attempt's);
   *  - no soft-phone call holds the contact's claim.
   *
   * `FOR UPDATE OF a, ct` makes the check exact against a concurrent writer: one that
   * committed first is seen (Postgres re-checks the locked rows' latest versions), and
   * one that comes second waits and then meets this write (an agent's disposition finds
   * the code stamped and is refused, the "auto-closed" answer).
   *
   * ── What it writes ─────────────────────────────────────────────────────────
   *
   * `dispositionCode` set: the attempt's `disposition_code` and `dispositioned_at`, with
   * no `dispositioned_by_user_id` (nobody recorded it, which is the code's meaning), and
   * the contact's `last_disposition`. Null: nothing on the attempt. The contact: `state`,
   * `last_outcome`, `next_attempt_at`, `suppressed_reason`, never `attempt_count` (the
   * attempt was counted when it ended), under `markState`'s DNC rule (a row carrying
   * `suppressed_reason = 'dnc'` stays `suppressed` with its `next_attempt_at`).
   *
   * Returns the contact state that landed, or null when either row had moved on and
   * nothing was written.
   */
  async closeLapsedWrapup(opts: {
    attemptId: string;
    contactId: string;
    /** The auto-close code to stamp, or null when none was owed. */
    dispositionCode: string | null;
    contactState: string;
    lastOutcome: string | null;
    nextAttemptAt: Date | null;
    suppressedReason: string | null;
  }): Promise<{ state: AgencyContactState; suppressed_reason: string | null } | null> {
    const { rows } = await getPool().query<{ state: AgencyContactState; suppressed_reason: string | null }>(
      `WITH target AS (
         SELECT a.id AS attempt_id, ct.id AS contact_id
           FROM agency_call_attempts a
           JOIN agency_contacts ct ON ct.id = a.contact_id
          WHERE a.id = $1
            AND ct.id = $2
            AND a.state = 'ended'
            AND a.disposition_code IS NULL
            AND ct.state = 'connected'
            AND NOT EXISTS (
                  SELECT 1 FROM agency_call_attempts n
                   WHERE n.contact_id = ct.id AND n.attempt_number > a.attempt_number)
            AND NOT EXISTS (
                  SELECT 1 FROM agency_manual_calls m
                   WHERE m.contact_id = ct.id AND m.settled_at IS NULL AND m.contact_claimed)
            FOR UPDATE OF a, ct
       ), stamped AS (
         UPDATE agency_call_attempts a
            SET disposition_code = $3,
                dispositioned_at = now(),
                updated_at = now()
           FROM target t
          WHERE a.id = t.attempt_id
            AND $3::text IS NOT NULL
         RETURNING a.id
       )
       UPDATE agency_contacts c
          SET state = CASE WHEN c.suppressed_reason = 'dnc' THEN 'suppressed' ELSE $4 END,
              last_outcome = COALESCE($5, c.last_outcome),
              last_disposition = COALESCE($3, c.last_disposition),
              next_attempt_at = CASE WHEN c.suppressed_reason = 'dnc' THEN c.next_attempt_at ELSE COALESCE($6, c.next_attempt_at) END,
              suppressed_reason = CASE WHEN c.suppressed_reason = 'dnc' THEN c.suppressed_reason ELSE COALESCE($7, c.suppressed_reason) END,
              updated_at = now()
         FROM target t
        WHERE c.id = t.contact_id
      RETURNING c.state, c.suppressed_reason`,
      [
        opts.attemptId,
        opts.contactId,
        opts.dispositionCode,
        opts.contactState,
        opts.lastOutcome,
        opts.nextAttemptAt,
        opts.suppressedReason,
      ],
    );
    return rows[0] ?? null;
  }
}

export const agencyAttemptRepository = new AgencyAttemptRepository();
