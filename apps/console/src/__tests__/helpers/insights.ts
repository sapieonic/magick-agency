import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsAllocationRow,
  AgencyInsightsHeadline,
  AgencyInsightsHealth,
  AgencyInsightsReadiness,
  AgencyInsightsRoster,
  AgencyInsightsSummary,
  AgencyInsightsTrends,
  AgencyInsightsUploads,
} from '../../types/agency-insights';
import type { AgencyCampaignStatus } from '../../types/agency';

/**
 * Insights wire samples that RECONCILE, as the server's would: the roster's
 * states sum to its total (1,000), attempts per contact sum to the attempted
 * (620), outcomes sum to dials (1,240) and dispositions to connected (400).
 * A test that wants an edge case overrides one field and says why.
 */

export const CAMPAIGN_ID = 'camp-1';
export const ZONE = 'Asia/Kolkata';

export function roster(over: Partial<AgencyInsightsRoster> = {}): AgencyInsightsRoster {
  return {
    total: 1000,
    waiting_due_now: 300,
    waiting_retry: 100,
    waiting_callback: 50,
    on_call: 3,
    in_wrapup: 2,
    completed: 400,
    exhausted: 80,
    suppressed_dnc: 40,
    suppressed_invalid: 15,
    suppressed_other: 10,
    attempted: 620,
    attempts_per_contact: { one: 300, two: 180, three: 90, four_plus: 50 },
    dials_placed: 1240,
    reconciliation: [
      { check: 'contact_states_vs_total', expected: 1000, actual: 1000, ok: true },
      { check: 'attempts_per_contact_vs_attempted', expected: 620, actual: 620, ok: true },
    ],
    ...over,
  };
}

const EMPTY_HEADLINE: AgencyInsightsHeadline = {
  running: null,
  paused: null,
  stopping: null,
  stopped: null,
  completed: null,
  draft: null,
};

const ANITA = { user_id: 'usr_anita', name: 'Anita Kulkarni' };

export function headlineFor(status: AgencyCampaignStatus): AgencyInsightsHeadline {
  switch (status) {
    case 'draft':
      return { ...EMPTY_HEADLINE, draft: { ready: false } };
    case 'running':
      return {
        ...EMPTY_HEADLINE,
        running: {
          agents_by_state: { offline: 2, available: 0, reserved: 0, on_call: 3, wrapup: 1, break: 0 },
          calls_live: 3,
          concurrency_in_use: 3,
          concurrency_limit: 40,
          dials_per_hour: 412,
          eta_seconds: 3 * 86_400 + 3600,
          stall: null,
          other_stalls: [],
          abandonment_rate_24h: { abandoned: 21, answered: 1000 },
        },
      };
    case 'paused':
      return {
        ...EMPTY_HEADLINE,
        paused: {
          paused_at: '2026-11-04T08:35:00.000Z',
          actor: ANITA,
          reason: 'supervisor',
          abandonment_rate_pct_at_pause: null,
          calls_finishing: 1,
          waiting_to_resume: 300,
          callbacks_missed_while_paused: 37,
          callbacks_due_before_window_end: 52,
        },
      };
    case 'stopping':
      return { ...EMPTY_HEADLINE, stopping: { stopped_at: '2026-11-04T10:10:00.000Z', actor: ANITA, calls_finishing: 2 } };
    case 'stopped':
      return {
        ...EMPTY_HEADLINE,
        stopped: {
          stopped_at: '2026-11-04T10:14:00.000Z',
          actor: ANITA,
          pending: 450,
          callbacks_scheduled: 50,
          never_attempted: 380,
          retry_matched: 520,
        },
      };
    case 'completed':
      return {
        ...EMPTY_HEADLINE,
        completed: {
          completed_at: '2026-11-08T12:01:00.000Z',
          duration_seconds: 8 * 86_400 + 8 * 3600,
          reached: 661,
          successes: 200,
          not_reached: 284,
          dnc: 40,
          retry_matched: 214,
        },
      };
  }
}

export function summary(status: AgencyCampaignStatus = 'running', over: Partial<AgencyInsightsSummary> = {}): AgencyInsightsSummary {
  return {
    campaign_id: CAMPAIGN_ID,
    name: 'EMI Recovery',
    status,
    account: { id: 'account-1', name: 'Pune Collections' },
    created_at: '2026-10-28T05:00:00.000Z',
    created_by: ANITA,
    started_at: status === 'draft' ? null : '2026-10-31T03:32:00.000Z',
    ended_at: status === 'stopped' || status === 'completed' ? '2026-11-04T10:14:00.000Z' : null,
    transitions: [{ to_status: 'running', at: '2026-10-31T03:32:00.000Z', actor: ANITA, reason: 'supervisor' }],
    dedupe_columns: ['Loan No'],
    parent_campaign: null,
    child_campaigns: [],
    settings: {
      timezone: ZONE,
      calling_window_start: '09:00:00',
      calling_window_end: '20:00:00',
      calling_days: [1, 2, 3, 4, 5],
      calling_hours_default: true,
      caller_ids: ['+912067124410'],
      max_attempts: 3,
      wrapup_seconds: 45,
      wrapup_auto_return: true,
      allow_wrapup_redial: true,
      wrapup_redial_limit: 2,
      allow_agent_retry: false,
      agent_retry_rounds: 0,
      agent_retry_cooldown_minutes: 0,
      override_outcomes: [{ code: 'ptp', label: 'Promise to pay', extra_attempts: 1, retry_delay: false, calling_hours: false }],
      record_calls: true,
      analysis_profile: null,
      abandonment_ceiling_pct: 3,
      assignment_mode: 'strict',
    },
    headline: headlineFor(status),
    roster: roster(),
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

export function readiness(over: Partial<AgencyInsightsReadiness> = {}): AgencyInsightsReadiness {
  return {
    campaign_id: CAMPAIGN_ID,
    ready: false,
    checks: [
      { code: 'roster_uploaded', result: 'pass', count: 1000, detail: { rejected: 212, duplicates: 96, dedupe_column: 'Loan No' } },
      { code: 'phone_column_mapped', result: 'pass', count: null, detail: { phone_column: 'Mobile' } },
      { code: 'outcomes_configured', result: 'pass', count: 9, detail: { overrides: 2 } },
      { code: 'caller_ids_present', result: 'pass', count: 4, detail: {} },
      { code: 'calling_hours_set', result: 'warn', count: null, detail: {} },
      { code: 'agents_staffed', result: 'pass', count: 6, detail: {} },
      { code: 'contacts_allocated', result: 'fail', count: 1410, detail: {} },
      { code: 'abandonment_clip', result: 'fail', count: null, detail: {} },
      { code: 'contacts_on_dnc', result: 'warn', count: 318, detail: {} },
    ],
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

type Counts = AgencyInsightsAllocation['totals'];

function counts(over: Partial<Counts> = {}): Counts {
  return {
    allocated: 400,
    attempted: 300,
    not_attempted: 100,
    due_now: 120,
    waiting_retry: 40,
    callbacks_due_today: 10,
    callbacks_overdue: 2,
    reached: 200,
    successes: 90,
    not_reached: 100,
    exhausted: 30,
    dnc: 20,
    redials: 12,
    retries_reopened: 3,
    retries_manual: 4,
    overrides_used: 5,
    last_activity_at: '2026-11-04T10:00:00.000Z',
    ...over,
  };
}

export function allocationRow(over: Partial<AgencyInsightsAllocationRow> = {}): AgencyInsightsAllocationRow {
  return {
    agent_user_id: 'usr_priya',
    agent_name: 'Priya Nair',
    staffed: true,
    state: 'on_call',
    last_seen_at: '2026-11-04T10:12:00.000Z',
    due_while_absent: 0,
    ...counts(),
    ...over,
  };
}

export function allocation(over: Partial<AgencyInsightsAllocation> = {}): AgencyInsightsAllocation {
  return {
    campaign_id: CAMPAIGN_ID,
    assignment_mode: 'strict',
    agents: [
      allocationRow(),
      allocationRow({ agent_user_id: 'usr_vikram', agent_name: 'Vikram Rao', state: 'offline', due_now: 60, successes: 40 }),
    ],
    unassigned: counts({ allocated: 200, attempted: 20, not_attempted: 180, due_now: 120, redials: 0, retries_reopened: 0, retries_manual: 0, overrides_used: 0 }),
    totals: counts({ allocated: 1000, attempted: 620, not_attempted: 380, due_now: 300 }),
    imbalance: { high: [{ agent_user_id: 'usr_priya', factor: 1.5 }], empty: [] },
    at_risk: {
      held_by_absent: [{ agent_user_id: 'usr_vikram', due: 60, away_since: '2026-11-04T09:25:00.000Z', staffed: true }],
      overdue_callbacks_absent_owner: 2,
    },
    absent_after_minutes: 30,
    history: [{ at: '2026-11-04T05:50:00.000Z', actor: ANITA, kind: 'rebalance', moved: 600, batch_id: 'b1' }],
    reconciliation: [{ check: 'allocated_plus_unassigned_vs_total', expected: 1000, actual: 1000, ok: true }],
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

const LIFETIME_RANGE = { from: '2026-10-31T03:30:00.000Z', to: '2026-11-04T10:15:00.000Z', lifetime: true, clamped: false, timezone: ZONE };

export function activity(over: Partial<AgencyInsightsActivity> = {}): AgencyInsightsActivity {
  return {
    campaign_id: CAMPAIGN_ID,
    range: LIFETIME_RANGE,
    calls: {
      dials: 1240,
      connected: 400,
      conversations: 400,
      // Voicemail and unwritten conversations are connected but reached nobody.
      human_connects: 360,
      successes: 200,
      by_outcome: {
        connected: 400,
        no_answer: 500,
        busy: 120,
        failed: 60,
        machine: 0,
        invalid: 20,
        abandoned: 10,
        agent_disconnected: 5,
        orphaned: 2,
        canceled: 120,
        null_outcome: 3,
      },
      redials: { placed: 41, connected: 29, chains_at_limit: 3, refused_at_limit: 1 },
      agent_retries: { reopened_dials: 6, reopened_connected: 2, manual_dials: 8, manual_connected: 3 },
      softphone_calls: 7,
      talk_seconds: 400 * 178,
      wrapup_seconds: 380 * 43,
      wrapup_measured: 380,
    },
    outcomes: [
      { code: 'ptp', label: 'Promise to pay', is_success: true, count: 150 },
      { code: 'paid', label: 'Paid', is_success: true, count: 50 },
      { code: 'not_interested', label: 'Not interested', is_success: false, count: 120 },
      { code: 'callback', label: 'Call back', is_success: false, count: 60 },
      { code: null, label: null, is_success: false, count: 20 },
    ],
    callbacks: {
      booked: 80,
      open_due_today: 10,
      open_overdue: 4,
      kept_on_time: 40,
      kept_late: 10,
      missed: 6,
      pending_future: 18,
      pending_due: 6,
      by_owner: [
        { agent_user_id: 'usr_priya', open: 8, overdue: 2 },
        { agent_user_id: null, open: 6, overdue: 2 },
      ],
    },
    overrides: [{ code: 'ptp', granted: 9, used: 5, by_agent: [{ agent_user_id: 'usr_priya', granted: 9, used: 5 }] }],
    no_outcome: { total: 20, by_resolution: { forced: 12, agent_left: 8 } },
    dnc_marked: { total: 3, by_agent: [{ user_id: 'usr_priya', count: 3 }] },
    agents: [
      {
        agent_user_id: 'usr_priya',
        agent_name: 'Priya Nair',
        online_seconds: 20_000,
        state_seconds: { available: 6000, on_call: 10_000, wrapup: 2000, break_by_reason: { lunch: 1800, training: 200 } },
        dials: 700,
        connected: 240,
        conversations: 240,
        human_connects: 220,
        successes: 90,
        talk_seconds: 240 * 180,
        wrapup_seconds: 230 * 40,
        wrapup_measured: 230,
        redials: 20,
        retries: 5,
        overrides: 5,
      },
      {
        agent_user_id: 'usr_vikram',
        agent_name: 'Vikram Rao',
        online_seconds: 18_000,
        state_seconds: { available: 8000, on_call: 8000, wrapup: 2000, break_by_reason: {} },
        dials: 540,
        connected: 160,
        conversations: 160,
        human_connects: 140,
        successes: 110,
        talk_seconds: 160 * 170,
        wrapup_seconds: 150 * 45,
        wrapup_measured: 150,
        redials: 21,
        retries: 9,
        overrides: 0,
      },
    ],
    never_joined: ['usr_meera'],
    reconciliation: [
      { check: 'outcomes_vs_dials', expected: 1240, actual: 1240, ok: true },
      { check: 'outcome_codes_vs_conversations', expected: 400, actual: 400, ok: true },
    ],
    as_of: '2026-11-04T10:12:00.000Z',
    pending_buckets: 0,
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

export function trends(over: Partial<AgencyInsightsTrends> = {}): AgencyInsightsTrends {
  return {
    campaign_id: CAMPAIGN_ID,
    range: LIFETIME_RANGE,
    bucket: 'day',
    buckets: [
      { bucket_start: '2026-10-31', dials: 300, first_dials: 290, human_connects: 80, connected: 90, conversations: 90, successes: 40, abandoned: 2, answered: 120, agents_online_peak: 4 },
      { bucket_start: '2026-11-01', dials: 10, first_dials: 10, human_connects: 3, connected: 3, conversations: 3, successes: 1, abandoned: 0, answered: 4, agents_online_peak: 1 },
      { bucket_start: '2026-11-02', dials: 0, first_dials: 0, human_connects: 0, connected: 0, conversations: 0, successes: 0, abandoned: 0, answered: 0, agents_online_peak: 0 },
      { bucket_start: '2026-11-03', dials: 500, first_dials: 485, human_connects: 140, connected: 160, conversations: 160, successes: 90, abandoned: 5, answered: 200, agents_online_peak: 6 },
      { bucket_start: '2026-11-04', dials: 430, first_dials: 414, human_connects: 137, connected: 147, conversations: 147, successes: 69, abandoned: 3, answered: 180, agents_online_peak: 5 },
    ],
    best_hours: [
      { hour: 10, dials: 200, first_dials: 190, human_connects: 45, connected: 50 },
      { hour: 18, dials: 100, first_dials: 95, human_connects: 36, connected: 38 },
      { hour: 21, dials: 10, first_dials: 10, human_connects: 9, connected: 9 },
    ],
    as_of: '2026-11-04T10:12:00.000Z',
    pending_buckets: 0,
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

export function health(over: Partial<AgencyInsightsHealth> = {}): AgencyInsightsHealth {
  return {
    campaign_id: CAMPAIGN_ID,
    range: LIFETIME_RANGE,
    abandonment: {
      rolling_24h: { abandoned: 21, answered: 1000 },
      ceiling_pct: 3,
      auto_pauses: [{ at: '2026-11-02T06:00:00.000Z', measured_pct: 3.4, ceiling_pct: 3 }],
    },
    predial_blocks: { dnc: 40, invalid: 15, outside_calling_hours_deferrals: 210 },
    caller_ids: [
      { caller_id: '+912067124410', dials: 1000, first_dials: 968, human_connects: 305, connected: 340 },
      { caller_id: '+912067124411', dials: 240, first_dials: 231, human_connects: 55, connected: 60 },
    ],
    concurrency_limit_minutes: 4,
    carrier_failures: 60,
    carrier_failures_by_code: [{ error_code: 'TELEPHONY_ERROR', count: 48 }, { error_code: null, count: 12 }],
    our_fault_retired: 2,
    stalls: {
      minutes_by_reason: {
        no_agents: 22,
        no_slots: 4,
        no_contacts: 0,
        no_reservations: 0,
        no_caller_ids: 0,
        nothing_due: 0,
        outside_calling_hours: 60,
      },
      episodes: [
        { reason: 'no_agents', started_at: '2026-11-04T04:00:00.000Z', ended_at: '2026-11-04T04:22:00.000Z', minutes: 22 },
      ],
      episodes_truncated: false,
    },
    recording: { connected: 400, recorded: 396 },
    analysis: null,
    pacing_history_since: '2026-11-04T00:00:00.000Z',
    as_of: '2026-11-04T10:12:00.000Z',
    pending_buckets: 0,
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}

export function uploads(over: Partial<AgencyInsightsUploads> = {}): AgencyInsightsUploads {
  return {
    campaign_id: CAMPAIGN_ID,
    uploads: [
      {
        job_id: 'job-2',
        file_name: 'october, cycle "B".csv',
        uploaded_by: ANITA,
        created_at: '2026-10-28T05:10:00.000Z',
        finished_at: '2026-10-28T05:11:00.000Z',
        status: 'committed',
        mode: 'append',
        rows_read: 1308,
        accepted: 1000,
        rejected: 212,
        rejected_by_reason: { invalid_phone: 180, missing_phone: 32 },
        duplicates: 96,
        dedupe_columns: ['Loan No'],
        has_rejected_export: true,
      },
    ],
    generated_at: '2026-11-04T10:12:08.000Z',
    ...over,
  };
}
