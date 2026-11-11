import { describe, expect, it } from 'vitest';
import type * as Api from '../src/api/agency/index';
import type { Same } from './type-equals';

/**
 * The console wire types that DIFFER from the dialer contract are derived from it
 * (`Omit`, `Partial`, `extends Core.X { … }`) rather than declared by hand, so a
 * member added to the dialer type reaches the console type without a second edit.
 *
 * The expectations below are the shapes these types had when they were still
 * hand-declared, written out (comments stripped), so the derivation is pinned to
 * change NOTHING the console compiles against: no member gained or lost, no
 * optionality or nullability tightened. A nested reference is to the current
 * `AgencyApi` name, which is pinned by its own line. Type-level: `pnpm lint`
 * fails, not `pnpm test`.
 */

interface OldAgencyStationIntervals {
  heartbeat_ms: number;
  heartbeat_grace_ms: number;
  reservation_lease_ms: number;
  countdown_ms: number;
  deferred_hangup_ms?: number;
}

interface OldAgencySessionBootstrap {
  session_id: string;
  campaign_id: string;
  campaign_name: string;
  agent_user_id: string;
  state: Api.AgencyAgentState;
  // Added deliberately (mobile app): the break's code, so a cold start can name it.
  break_reason?: string;
  campaign_status: Api.AgencyCampaignStatus;
  station_ws_url: string;
  station_token_expires_at?: string;
  disposition_catalog: Api.AgencyDisposition[];
  wrapup_seconds: number;
  wrapup_auto_return: boolean;
  allow_wrapup_redial?: boolean;
  // Added deliberately (contact assignment): the mode, agent retry, and the agent's queue at join.
  assignment_mode?: Api.AgencyAssignmentMode;
  allow_agent_retry?: boolean;
  queue?: Api.AgencyQueueState;
  record_calls: boolean;
  break_reasons: Api.AgencyBreakReason[];
  context_display: Api.AgencyContextDisplay;
  intervals: Api.AgencyStationIntervals;
  retry_context?: Api.AgencyRetryContext;
}

interface OldAgencySessionStateResponse {
  session_id: string;
  // Added with the soft phone (docs/softphone.md): derived from the dialer type, deliberately.
  kind: Api.AgencySessionKind;
  state: Api.AgencyAgentState;
  since: string;
  pending_state?: Api.AgencyAgentState | null;
  break_reason?: string | null;
}

interface OldAgencyDispositionResponse {
  attempt_id: string;
  contact_id: string;
  disposition_code: string;
  contact_state: string;
  next_attempt_at: string | null;
  callback_requested_at?: string | null;
  agent_state: Api.AgencyAgentState;
}

interface OldAgencyDncResponse {
  attempt_id: string;
  contact_id: string;
  phone_e164: string;
  contact_state: string;
  dnc_recorded: boolean;
}

interface OldAgencyStationBridgeStatusFrame {
  event: 'status';
  status: string;
}

interface OldAgencyWrapupState {
  attempt_id: string;
  ends_at: string | null;
  requires_disposition: boolean;
  disposition_submitted: boolean;
  held_reason?: Api.AgencyWrapupHold | null;
  redial_remaining?: number | null;
  auto_return: boolean;
}

interface OldAgencyStationReadyFrame {
  event: 'ready';
  session_id: string;
  state: Api.AgencyAgentState;
  // Added deliberately (mobile app): the break's code, so a reconnect can name it.
  break_reason?: string;
  active_attempt?: Api.AgencyActiveAttempt;
  // Added deliberately (contact assignment): the agent's queue at reconnect.
  queue?: Api.AgencyQueueState;
  active_wrapup?: Api.AgencyWrapupState;
  missed_release?: Api.AgencyMissedRelease;
  pending_state?: Api.AgencyAgentState;
  pending_break_reason?: string;
}

interface OldAgencySupervisorAgent {
  session_id: string;
  agent_user_id: string;
  agent_name: string | null;
  state: Api.AgencyAgentLiveState;
  state_since: string;
  connected: boolean | null;
  break_reason: string | null;
  calls_handled: number;
  // Added deliberately (wrap-up redial, 0008): the session's redials.
  redials?: number;
  // Added deliberately (mobile app, 0006): the floor's phone marker.
  client_kind: 'web' | 'mobile';
  // Added deliberately (inbound calls P2, 0027): the floor's "Inbound call" marker.
  on_inbound_call: boolean;
  // Added deliberately (inbound fix pass): the floor's inbound wrap-up and its "Close and make available".
  inbound_outcome_owed?: boolean;
  // Added deliberately (IQ56): the live station can take inbound calls (`caps=inbound`); null: none here.
  can_take_inbound: boolean | null;
}

interface OldAgencyCampaignStats {
  campaign_id?: string;
  status?: Api.AgencyCampaignStatus;
  contacts_total?: number;
  contacts_pending?: number;
  contacts_in_flight?: number;
  // Added deliberately (IN8): contacts bridged and owing an outcome, so the buckets sum.
  contacts_connected?: number;
  contacts_completed?: number;
  contacts_suppressed?: number;
  contacts_exhausted?: number;
  retries_pending?: number;
  attempts_live?: number;
  attempts_total?: number;
  attempts_connected?: number;
  agents_live?: number;
  abandoned_24h?: number;
  answered_24h?: number;
  abandonment_rate_24h_pct?: number | null;
  stall: Api.AgencyStall | null;
  other_stalls: Api.AgencyStallCode[];
  concurrency_limit: number;
  concurrency_in_use: number | null;
  // Added deliberately (MC7): the campaign's place in the account's line limit.
  concurrency?: Api.AgencyCampaignConcurrency | null;
  abandonment_ceiling_pct: number;
  agents_by_state?: Api.AgencyAgentsByState;
  agents?: Api.AgencySupervisorAgent[];
  aht_seconds?: number | null;
  aht_seconds_including_machine?: number | null;
  avg_wrapup_seconds?: number | null;
  connect_rate_pct?: number | null;
  // Added deliberately (IN10): the connect rate's own denominator, for its fraction and floor.
  first_dials_placed?: number;
  human_connects?: number;
  machine_connects?: number;
  unclassified_connects?: number;
  machine_connects_available?: boolean;
  attempts_success?: number;
  success_rate_pct?: number | null;
  attempts_retried?: number;
  // Added deliberately (wrap-up redial, 0008).
  attempts_redialed?: number;
  agents_peak?: number | null;
}

interface OldAgencyCampaignLineage {
  root_campaign_id: string;
  campaigns: Api.AgencyCampaignLineageEntry[];
}

interface OldAgencyCampaignLineageEntry {
  id: string;
  name: string;
  status: string;
  retry_generation: number;
  parent_campaign_id: string | null;
  contacts_total: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface OldAgencyDispositionEntry {
  code: string;
  label: string;
  is_success?: boolean;
  requires_note?: boolean;
  requires_datetime?: boolean;
  terminal?: boolean;
  suppress?: boolean;
  retry?: Api.AgencyRetryRule;
  // Added deliberately (contact assignment, phase 2): the outcome's override grant.
  override?: Api.AgencyDispositionOverride;
}

interface OldAgencyRetryRule {
  delay_minutes?: number;
  max_attempts: number;
}

interface OldAgencyAttempt {
  id: string;
  contact_id: string;
  campaign_id: string;
  attempt_number: number;
  phone_e164: string;
  caller_id: string;
  agent_user_id: string | null;
  agent_name?: string | null;
  reserved_agent_id: string | null;
  state: Api.AgencyAttemptState;
  outcome: Api.AgencyAttemptOutcome | null;
  disposition_code: string | null;
  // Added deliberately (automatic outcomes, OD1–OD8): the outcome an unanswered call was stamped with.
  auto_disposition_code?: string | null;
  notes: string | null;
  callback_at: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  webrtc_call_id: string | null;
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: number | null;
  // Added deliberately (wrap-up redial, 0008): the chain link.
  redial_of_attempt_id?: string | null;
  redial_number?: number;
  created_at: string;
}

interface OldAgencyOccupancy {
  shift_seconds: number;
  by_state: Api.AgencyAgentsByState;
}

interface OldAgencyAgentStatsTotals {
  attempts: number;
  connected: number;
  connect_rate_pct: number | null;
  successes: number;
  success_rate_pct: number | null;
  talk_seconds: number;
  wrapup_seconds: number;
  aht_seconds: number | null;
  campaigns: number;
  occupancy?: Api.AgencyOccupancy | null;
}

interface OldAgencyAgentStatsBucket {
  bucket_start: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  occupancy?: Api.AgencyOccupancy | null;
}

interface OldAgencyAgentStats {
  agent_user_id: string;
  bucket: Api.AgencyStatsBucketWidth;
  from: string;
  to: string;
  totals: Api.AgencyAgentStatsTotals;
  buckets: Api.AgencyAgentStatsBucket[];
  by_campaign: Api.AgencyAgentStatsByCampaign[];
}

interface OldAgencyRosterAgentRow {
  agent_user_id: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  campaigns: number;
  shift_seconds: number;
  break_seconds: number;
  occupancy_pct: number | null;
  last_dialed_at: string | null;
  rates_reportable: boolean;
  success_rate_reportable?: boolean;
}

interface OldAgencyRosterBenchmark {
  agents: number;
  agents_rated: number;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  shift_seconds?: number;
  break_seconds?: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  connect_rate: Api.AgencyRosterPercentiles;
  success_rate: Api.AgencyRosterPercentiles;
  aht?: Api.AgencyRosterPercentiles;
  occupancy_pct: Api.AgencyRosterPercentiles;
}

interface OldAgencyRosterPage {
  from: string;
  to: string;
  campaign_id: string | null;
  sort: Api.AgencyRosterSort;
  order: Api.AgencyRosterOrder;
  limit: number;
  total_agents: number;
  rows: Api.AgencyRosterAgentRowWithName[];
  benchmark: Api.AgencyRosterBenchmark;
  inactive_omitted: number;
  unattributed_omitted?: number;
}

interface OldAgencyGroupRow {
  key: Api.AgencyGroupKey;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  connect_rate_pct: number | null;
  success_rate_pct: number | null;
  aht_seconds: number | null;
  rates_reportable?: boolean;
  success_rate_reportable?: boolean;
}

interface OldAgencyGroupPage {
  from: string;
  to: string;
  campaign_id: string | null;
  group_by: Api.AgencyGroupDimension[];
  sort: Api.AgencyGroupSort;
  order: Api.AgencyRosterOrder;
  limit: number;
  total_groups: number;
  rows: Api.AgencyGroupRowWithName[];
  inactive_omitted: number;
  unattributed_omitted?: number;
  resolved_timezone?: string | null;
}

const _pinned: [
  Same<Api.AgencyStationIntervals, OldAgencyStationIntervals>,
  Same<Api.AgencySessionBootstrap, OldAgencySessionBootstrap>,
  Same<Api.AgencySessionStateResponse, OldAgencySessionStateResponse>,
  Same<Api.AgencyDispositionResponse, OldAgencyDispositionResponse>,
  Same<Api.AgencyDncResponse, OldAgencyDncResponse>,
  Same<Api.AgencyStationBridgeStatusFrame, OldAgencyStationBridgeStatusFrame>,
  Same<Api.AgencyWrapupState, OldAgencyWrapupState>,
  Same<Api.AgencyStationReadyFrame, OldAgencyStationReadyFrame>,
  Same<Api.AgencySupervisorAgent, OldAgencySupervisorAgent>,
  Same<Api.AgencyCampaignStats, OldAgencyCampaignStats>,
  Same<Api.AgencyCampaignLineage, OldAgencyCampaignLineage>,
  Same<Api.AgencyCampaignLineageEntry, OldAgencyCampaignLineageEntry>,
  Same<Api.AgencyDispositionEntry, OldAgencyDispositionEntry>,
  Same<Api.AgencyRetryRule, OldAgencyRetryRule>,
  Same<Api.AgencyAttempt, OldAgencyAttempt>,
  Same<Api.AgencyOccupancy, OldAgencyOccupancy>,
  Same<Api.AgencyAgentStatsTotals, OldAgencyAgentStatsTotals>,
  Same<Api.AgencyAgentStatsBucket, OldAgencyAgentStatsBucket>,
  Same<Api.AgencyAgentStats, OldAgencyAgentStats>,
  Same<Api.AgencyRosterAgentRow, OldAgencyRosterAgentRow>,
  Same<Api.AgencyRosterBenchmark, OldAgencyRosterBenchmark>,
  Same<Api.AgencyRosterPage, OldAgencyRosterPage>,
  Same<Api.AgencyGroupRow, OldAgencyGroupRow>,
  Same<Api.AgencyGroupPage, OldAgencyGroupPage>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
void _pinned;

describe('derived console wire types', () => {
  it('pins 24 shapes at type level', () => {
    expect(_pinned).toHaveLength(24);
  });
});
