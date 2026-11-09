/**
 * The campaign report fixture, and the per-campaign builder the account fixture reuses. Each
 * campaign is simulated per agent per day (dials, conversations split by outcome code, talk), and
 * every Insights object is summed from those same cells, so the trend buckets sum to the calls
 * block, the agent rows sum to it, the best hours sum to it, and the attempts sheet has one row
 * per counted dial.
 */
import type { AgencyAttemptOutcome } from '@magick-agency/contracts';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAgentActivityRow,
  AgencyInsightsHealth,
  AgencyInsightsSummary,
  AgencyInsightsTrendBucket,
  AgencyInsightsTrends,
} from '@magick-agency/contracts/api/agency/insights';
import type { CampaignReportDataset, ReportDetailFile } from '@magick-agency/contracts/reports';
import { REPORT_DATASET_VERSION } from '@magick-agency/contracts/reports';
import { ACCOUNT, TENANT } from './agent';
import { between, iso, isoWeekday, localDays, localInstant, ndjsonGz, phone, seeded, splitInt, weighted, KOLKATA_OFFSET } from './util';

export const FROM = '2026-10-09';
export const TO = '2026-11-07';
export const DAYS = 30;
export const GENERATED_AT = '2026-11-08T03:30:00Z';

export interface AgentRef {
  id: string;
  name: string | null;
  /** Relative daily volume (1 = a full-time agent on this campaign). */
  load: number;
}

export const FLOOR_AGENTS: AgentRef[] = [
  { id: 'a7e3b9d1-2c4f-4e8a-b6d0-9f1e2a3b4c5d', name: 'Priya Sharma', load: 1 },
  { id: 'b1f2e3d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Arjun Mehta', load: 1.1 },
  { id: 'c2a3b4c5-6d7e-4f80-9a1b-2c3d4e5f6a7b', name: 'Fatima Khan', load: 0.95 },
  { id: 'd3b4c5d6-7e8f-4091-8b2c-3d4e5f6a7b8c', name: 'Rahul Verma', load: 0.85 },
  { id: 'e4c5d6e7-8f90-41a2-9c3d-4e5f6a7b8c9d', name: 'Ananya Iyer', load: 1.05 },
  { id: 'f5d6e7f8-90a1-42b3-8d4e-5f6a7b8c9d0e', name: 'Vikram Rao', load: 0.7 },
  // A user since removed from the tenant: the name no longer resolves.
  { id: '0a6e7f80-a1b2-43c4-9e5f-6a7b8c9d0e1f', name: null, load: 0.4 },
];
/** A new joiner: too few dials for any rate of theirs to be quoted. */
export const NEW_JOINER: AgentRef = { id: '1b7f8091-b2c3-44d5-8f60-7b8c9d0e1f2a', name: 'Kavya Nair', load: 0 };

type Code = 'ptp' | 'paid' | 'callback' | 'not_interested' | 'wrong_number' | 'dispute' | 'voicemail' | null;
const CODES: ReadonlyArray<readonly [Code, number]> = [
  ['ptp', 17],
  ['paid', 4],
  ['callback', 12],
  ['not_interested', 29],
  ['wrong_number', 8],
  ['dispute', 6],
  ['voicemail', 14],
  [null, 2],
];
const LABELS: Record<string, string> = {
  ptp: 'Promise to pay',
  paid: 'Already paid',
  callback: 'Callback requested',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  dispute: 'Disputes the balance',
  voicemail: 'Voicemail',
};
const SUCCESS = new Set<Code>(['ptp', 'paid']);
const HOUR_WEIGHTS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 10, 12, 10, 7, 6, 8, 10, 11, 9, 0, 0, 0, 0, 0];

interface Cell {
  date: string;
  agent: AgentRef | null;
  dials: number;
  redials: number;
  connected: number;
  conversations: number;
  codes: Map<Code, number>;
  human: number;
  successes: number;
  talk: number;
  wrapup: number;
  wrapupMeasured: number;
  online: number;
  onCall: number;
  wrapState: number;
  available: number;
  breaks: Record<string, number>;
  abandoned: number;
  noAnswer: number;
  busy: number;
  machine: number;
  failed: number;
}

export interface CampaignSpec {
  id: string;
  name: string;
  timezone: string;
  offsetMinutes: number;
  status: CampaignReportDataset['campaign']['status'];
  agents: AgentRef[];
  seed: number;
  /** Mean dials per full-time agent per day. */
  dialsPerDay: number;
  callerIds: string[];
  recordCalls: boolean;
  runId: string;
}

export const SPRING_RECOVERY: CampaignSpec = {
  id: 'c1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b',
  name: 'Spring Recovery',
  timezone: 'Asia/Kolkata',
  offsetMinutes: KOLKATA_OFFSET,
  status: 'running',
  agents: FLOOR_AGENTS,
  seed: 31,
  dialsPerDay: 96,
  callerIds: ['+91 80 4718 2290', '+91 80 4718 2291', '+91 22 6120 7735'],
  recordCalls: true,
  runId: '4c1d7e2a-8b3f-4a6c-9d5e-1f2a3b4c5d6e',
};

export interface BuiltCampaign {
  dataset: CampaignReportDataset;
  details: Map<string, Buffer>;
  /** The per-agent cells, for the account fixture's roster. */
  agentRows: AgencyInsightsAgentActivityRow[];
}

export function buildCampaign(spec: CampaignSpec, options: { attemptsCap?: number; accountScope?: string } = {}): BuiltCampaign {
  const rnd = seeded(spec.seed);
  const days = localDays(FROM, DAYS);
  const cells: Cell[] = [];
  for (const date of days) {
    const wd = isoWeekday(date);
    if (wd === 7) continue; // calling days Monday to Saturday
    let abandonedToday = 0;
    for (const agent of spec.agents) {
      const works = rnd() < (wd === 6 ? 0.45 : 0.9) * Math.min(1, agent.load + 0.3);
      if (!works || agent.load <= 0) continue;
      const dials = Math.max(8, Math.round(spec.dialsPerDay * agent.load * (0.8 + rnd() * 0.4) * (wd === 6 ? 0.5 : 1)));
      const redials = Math.round(dials * (0.015 + rnd() * 0.02));
      const skill = 0.82 + (parseInt(agent.id.slice(0, 2), 16) % 37) / 100;
      const connected = Math.min(dials, Math.round(dials * (0.44 + rnd() * 0.07) * Math.sqrt(skill)));
      const redialConnected = Math.min(connected, Math.round(redials * 0.4));
      const conversations = connected - redialConnected;
      const tilt = (code: Code) => (code === 'ptp' ? skill * skill : code === 'paid' ? skill : code === 'voicemail' || code === null ? 1 / skill : 1);
      const parts = splitInt(conversations, CODES.map(([code, w]) => w * tilt(code) * (0.85 + rnd() * 0.3)));
      const codes = new Map<Code, number>(CODES.map(([c], i) => [c, parts[i]!]));
      const human = conversations - (codes.get('voicemail') ?? 0) - (codes.get(null) ?? 0);
      const successes = (codes.get('ptp') ?? 0) + (codes.get('paid') ?? 0);
      const talk = connected * Math.round(between(rnd, 135, 165) * (0.9 + skill * 0.15));
      const wrapupMeasured = Math.round(connected * 0.95);
      const wrapup = wrapupMeasured * Math.round(between(rnd, 26, 38) + (parseInt(agent.id.slice(2, 4), 16) % 23));
      const onCall = talk + connected * 2;
      const wrapState = Math.round(wrapup / 0.95);
      const breaks = { lunch: between(rnd, 2100, 3000), tea: between(rnd, 1200, 1900), ...(rnd() < 0.2 ? { soft_phone: between(rnd, 180, 480) } : {}) };
      const breakTotal = Object.values(breaks).reduce((s, v) => s + v, 0);
      const online = Math.round((onCall + wrapState) / (0.48 + rnd() * 0.08)) + breakTotal;
      const available = online - onCall - wrapState - breakTotal;
      const unanswered = dials - connected;
      const [noAnswer, busy, machine, failed] = splitInt(unanswered, [62, 18, 16, 4]) as [number, number, number, number];
      cells.push({
        date, agent, dials, redials, connected, conversations, codes, human, successes, talk, wrapup, wrapupMeasured,
        online, onCall, wrapState, available, breaks, abandoned: 0, noAnswer, busy, machine, failed,
      });
      abandonedToday += Math.round(connected * (0.008 + rnd() * 0.012));
    }
    if (abandonedToday > 0) {
      // Answered calls that reached no agent: dials reserved to nobody.
      cells.push({
        date, agent: null, dials: abandonedToday, redials: 0, connected: 0, conversations: 0, codes: new Map(), human: 0, successes: 0,
        talk: 0, wrapup: 0, wrapupMeasured: 0, online: 0, onCall: 0, wrapState: 0, available: 0, breaks: {}, abandoned: abandonedToday,
        noAnswer: 0, busy: 0, machine: 0, failed: 0,
      });
    }
  }
  if (spec.agents.includes(NEW_JOINER) || spec.agents.some((a) => a.id === NEW_JOINER.id)) {
    // The new joiner's single afternoon.
    cells.push({
      date: '2026-11-06', agent: NEW_JOINER, dials: 15, redials: 1, connected: 7, conversations: 7,
      codes: new Map<Code, number>([['ptp', 1], ['not_interested', 3], ['voicemail', 2], ['callback', 1]]), human: 5, successes: 1,
      talk: 7 * 132, wrapup: 7 * 52, wrapupMeasured: 7, online: 2 * 3600, onCall: 7 * 134, wrapState: 7 * 55, available: 2 * 3600 - 7 * 189 - 900,
      breaks: { tea: 900 }, abandoned: 0, noAnswer: 5, busy: 2, machine: 1, failed: 0,
    });
  }

  const sumOf = (rows: Cell[], k: keyof Cell) => rows.reduce((s, c) => s + (c[k] as number), 0);
  const all = cells;
  const dials = sumOf(all, 'dials');
  const redials = sumOf(all, 'redials');
  const connected = sumOf(all, 'connected');
  const conversations = sumOf(all, 'conversations');
  const human = sumOf(all, 'human');
  const successes = sumOf(all, 'successes');
  const abandoned = sumOf(all, 'abandoned');
  const codeTotals = new Map<Code, number>();
  for (const c of all) for (const [code, n] of c.codes) codeTotals.set(code, (codeTotals.get(code) ?? 0) + n);

  // ── Trends: one bucket per local day, zeros included ────────────────────────
  const buckets: AgencyInsightsTrendBucket[] = days.map((date) => {
    const day = all.filter((c) => c.date === date);
    const d = sumOf(day, 'dials');
    const r = sumOf(day, 'redials');
    const conn = sumOf(day, 'connected');
    const ab = sumOf(day, 'abandoned');
    return {
      // `YYYY-MM-DD` in the campaign's zone, as Insights serves a `day` bucket.
      bucket_start: date,
      dials: d,
      first_dials: d - r,
      human_connects: sumOf(day, 'human'),
      connected: conn,
      conversations: sumOf(day, 'conversations'),
      successes: sumOf(day, 'successes'),
      abandoned: ab,
      answered: conn + ab,
      agents_online_peak: Math.max(0, day.filter((c) => c.agent).length - (day.length > 3 ? 1 : 0)),
    };
  });
  const hourDials = splitInt(dials, HOUR_WEIGHTS);
  const hourFirst = splitInt(dials - redials, HOUR_WEIGHTS.map((w, h) => w * (h === 17 || h === 18 ? 1.08 : 1)));
  const hourConnected = splitInt(connected, HOUR_WEIGHTS.map((w, h) => w * (h >= 16 ? 1.15 : h <= 10 ? 0.85 : 1)));
  const hourHuman = splitInt(human, HOUR_WEIGHTS.map((w, h) => w * (h >= 16 ? 1.25 : h <= 10 ? 0.8 : 1)));
  const bestHours = HOUR_WEIGHTS.map((w, hour) => ({ hour, dials: hourDials[hour]!, first_dials: hourFirst[hour]!, human_connects: hourHuman[hour]!, connected: hourConnected[hour]! })).filter(
    (h) => h.dials > 0,
  );

  const rangeObj = { from: FROM, to: TO, lifetime: false, clamped: false, timezone: spec.timezone };
  const asOf = '2026-11-08T03:15:00Z';
  const trends: AgencyInsightsTrends = {
    campaign_id: spec.id,
    range: rangeObj,
    bucket: 'day',
    buckets,
    best_hours: bestHours,
    as_of: asOf,
    pending_buckets: 0,
    generated_at: GENERATED_AT,
  };

  // ── Agents ──────────────────────────────────────────────────────────────────
  const agentIds = [...new Set(all.map((c) => c.agent?.id ?? null))];
  const agentRows: AgencyInsightsAgentActivityRow[] = agentIds.map((id) => {
    const mine = all.filter((c) => (c.agent?.id ?? null) === id);
    const ref = mine[0]!.agent;
    const breakByReason: Record<string, number> = {};
    for (const c of mine) for (const [k, v] of Object.entries(c.breaks)) breakByReason[k] = (breakByReason[k] ?? 0) + v;
    return {
      agent_user_id: id,
      agent_name: ref?.name ?? null,
      online_seconds: sumOf(mine, 'online'),
      state_seconds: { available: sumOf(mine, 'available'), on_call: sumOf(mine, 'onCall'), wrapup: sumOf(mine, 'wrapState'), break_by_reason: breakByReason },
      dials: sumOf(mine, 'dials'),
      connected: sumOf(mine, 'connected'),
      conversations: sumOf(mine, 'conversations'),
      human_connects: sumOf(mine, 'human'),
      successes: sumOf(mine, 'successes'),
      talk_seconds: sumOf(mine, 'talk'),
      wrapup_seconds: sumOf(mine, 'wrapup'),
      wrapup_measured: sumOf(mine, 'wrapupMeasured'),
      redials: sumOf(mine, 'redials'),
      retries: id ? Math.round(sumOf(mine, 'dials') * 0.006) : 0,
      overrides: id ? Math.round(sumOf(mine, 'dials') * 0.002) : 0,
    };
  });
  agentRows.sort((a, b) => b.dials - a.dials);

  const byOutcome: Record<AgencyAttemptOutcome, number> & { null_outcome: number } = {
    connected: connected - 9,
    no_answer: sumOf(all, 'noAnswer'),
    busy: sumOf(all, 'busy'),
    failed: sumOf(all, 'failed'),
    machine: sumOf(all, 'machine'),
    invalid: 0,
    abandoned,
    agent_disconnected: 9,
    orphaned: 0,
    canceled: 0,
    null_outcome: 0,
  };
  const callbacksBooked = codeTotals.get('callback') ?? 0;
  const owners = agentRows.filter((a) => a.agent_user_id);
  const onTime = Math.round(callbacksBooked * 0.81);
  const late = Math.round(callbacksBooked * 0.09);
  const missed = Math.round(callbacksBooked * 0.04);
  const pendingFuture = Math.round(callbacksBooked * 0.04);
  const pendingDue = callbacksBooked - onTime - late - missed - pendingFuture;
  const openDue = splitInt(pendingDue, owners.map((a) => a.dials));
  const openFuture = splitInt(pendingFuture, owners.map((a) => a.dials));
  const noOutcome = codeTotals.get(null) ?? 0;
  const [skipped, timeout, reaper] = splitInt(noOutcome, [5, 3, 1]) as [number, number, number];
  const dnc = splitInt(Math.round(conversations * 0.004), owners.map((a) => a.conversations));
  const overridesUsed = owners.reduce((s, a) => s + a.overrides, 0);

  const activity: AgencyInsightsActivity = {
    campaign_id: spec.id,
    range: rangeObj,
    calls: {
      dials,
      connected,
      human_connects: human,
      conversations,
      successes,
      by_outcome: byOutcome,
      redials: { placed: redials, connected: Math.round(redials * 0.4), chains_at_limit: Math.round(redials * 0.1), refused_at_limit: 3 },
      agent_retries: { reopened_dials: Math.round(dials * 0.004), reopened_connected: Math.round(dials * 0.002), manual_dials: Math.round(dials * 0.002), manual_connected: Math.round(dials * 0.001) },
      softphone_calls: 0,
      talk_seconds: sumOf(all, 'talk'),
      wrapup_seconds: sumOf(all, 'wrapup'),
      wrapup_measured: sumOf(all, 'wrapupMeasured'),
    },
    outcomes: [...codeTotals.entries()]
      .map(([code, n]) => ({ code, label: code ? LABELS[code]! : null, is_success: SUCCESS.has(code), count: n }))
      .sort((a, b) => b.count - a.count),
    callbacks: {
      booked: callbacksBooked,
      open_due_today: Math.min(pendingDue, 2),
      open_overdue: Math.max(0, pendingDue - 2),
      kept_on_time: onTime,
      kept_late: late,
      missed,
      pending_future: pendingFuture,
      pending_due: pendingDue,
      by_owner: owners.map((a, i) => ({ agent_user_id: a.agent_user_id, open: openDue[i]! + openFuture[i]!, overdue: openDue[i]! })),
    },
    overrides: [
      {
        code: 'ptp',
        granted: overridesUsed + 6,
        used: overridesUsed,
        by_agent: owners.map((a) => ({ agent_user_id: a.agent_user_id, granted: a.overrides + 1, used: a.overrides })).slice(0, 6),
      },
    ],
    no_outcome: { total: noOutcome, by_resolution: { agent_skipped: skipped, wrapup_timeout: timeout, reaper } },
    dnc_marked: { total: dnc.reduce((s, v) => s + v, 0), by_agent: owners.map((a, i) => ({ user_id: a.agent_user_id, count: dnc[i]! })) },
    agents: agentRows,
    never_joined: ['2c809102-c3d4-45e6-9071-8c9d0e1f2a3b'],
    reconciliation: [
      { check: 'outcomes_sum_to_conversations', expected: conversations, actual: conversations, ok: true },
      { check: 'agents_sum_to_dials', expected: dials, actual: dials, ok: true },
    ],
    as_of: asOf,
    pending_buckets: 0,
    generated_at: GENERATED_AT,
  };

  const callerSplit = splitInt(dials, spec.callerIds.map((_, i) => [5, 4, 2][i] ?? 1));
  const callerFirst = splitInt(dials - redials, spec.callerIds.map((_, i) => [5, 4, 2][i] ?? 1));
  const callerConnected = splitInt(connected, spec.callerIds.map((_, i) => [5.2, 4, 1.6][i] ?? 1));
  const callerHuman = splitInt(human, spec.callerIds.map((_, i) => [5.4, 4, 1.4][i] ?? 1));
  const recorded = spec.recordCalls ? connected - 14 : 0;
  const health: AgencyInsightsHealth = {
    campaign_id: spec.id,
    range: rangeObj,
    abandonment: {
      rolling_24h: { abandoned: 6, answered: 402 },
      ceiling_pct: 3,
      auto_pauses: spec.seed === 31 ? [{ at: '2026-10-22T06:42:00Z', measured_pct: 3.4, ceiling_pct: 3 }] : [],
    },
    predial_blocks: { dnc: Math.round(dials * 0.003), invalid: Math.round(dials * 0.002), outside_calling_hours_deferrals: Math.round(dials * 0.01) },
    caller_ids: spec.callerIds.map((caller_id, i) => ({ caller_id, dials: callerSplit[i]!, first_dials: callerFirst[i]!, human_connects: callerHuman[i]!, connected: callerConnected[i]! })),
    concurrency_limit_minutes: spec.seed === 31 ? 46 : 0,
    carrier_failures: sumOf(all, 'failed'),
    carrier_failures_by_code: [
      { error_code: '503', count: Math.round(sumOf(all, 'failed') * 0.6) },
      { error_code: '486', count: sumOf(all, 'failed') - Math.round(sumOf(all, 'failed') * 0.6) },
    ],
    our_fault_retired: spec.seed === 31 ? 5 : 1,
    stalls: {
      minutes_by_reason: { no_agents: 95, no_slots: 12, no_contacts: 0, no_reservations: 7, no_caller_ids: 0, nothing_due: 210, outside_calling_hours: 0 },
      episodes: [
        { reason: 'no_agents', started_at: '2026-10-14T07:31:00Z', ended_at: '2026-10-14T08:16:00Z', minutes: 45 },
        { reason: 'nothing_due', started_at: '2026-10-30T11:02:00Z', ended_at: '2026-10-30T12:40:00Z', minutes: 98 },
        { reason: 'no_slots', started_at: '2026-10-22T06:30:00Z', ended_at: '2026-10-22T06:42:00Z', minutes: 12 },
      ],
      episodes_truncated: false,
    },
    recording: { connected, recorded },
    analysis: null,
    pacing_history_since: '2026-09-01T00:00:00Z',
    as_of: asOf,
    pending_buckets: 0,
    generated_at: GENERATED_AT,
  };

  const agentsOnline = 4;
  const summary: AgencyInsightsSummary = {
    campaign_id: spec.id,
    name: spec.name,
    status: spec.status,
    account: { id: ACCOUNT.id, name: ACCOUNT.name },
    created_at: '2026-09-28T05:12:00Z',
    created_by: { user_id: '7d1e2f30-4a5b-46c7-8d9e-0f1a2b3c4d5e', name: 'Meera Joshi' },
    started_at: '2026-10-01T03:30:00Z',
    ended_at: null,
    transitions: [
      { to_status: 'running', at: '2026-10-01T03:30:00Z', actor: { user_id: '7d1e2f30-4a5b-46c7-8d9e-0f1a2b3c4d5e', name: 'Meera Joshi' }, reason: null },
      { to_status: 'paused', at: '2026-10-22T06:42:00Z', actor: null, reason: 'abandonment_ceiling' },
      { to_status: 'running', at: '2026-10-22T07:05:00Z', actor: { user_id: '7d1e2f30-4a5b-46c7-8d9e-0f1a2b3c4d5e', name: 'Meera Joshi' }, reason: null },
    ],
    dedupe_column: 'account_number',
    parent_campaign: null,
    child_campaigns: [],
    settings: {
      timezone: spec.timezone,
      calling_window_start: '09:00',
      calling_window_end: '19:00',
      calling_days: [1, 2, 3, 4, 5, 6],
      calling_hours_default: false,
      caller_ids: spec.callerIds,
      max_attempts: 4,
      wrapup_seconds: 45,
      wrapup_auto_return: true,
      allow_wrapup_redial: true,
      wrapup_redial_limit: 1,
      allow_agent_retry: true,
      agent_retry_rounds: 1,
      agent_retry_cooldown_minutes: 60,
      override_outcomes: [{ code: 'ptp', label: 'Promise to pay', extra_attempts: 1, retry_delay: true, calling_hours: true }],
      record_calls: spec.recordCalls,
      analysis_profile: null,
      abandonment_ceiling_pct: 3,
      assignment_mode: 'pool',
    },
    headline: {
      running:
        spec.status === 'running'
          ? {
              agents_by_state: { offline: 2, available: 1, reserved: 0, on_call: 2, wrapup: 1, break: 0 },
              calls_live: 3,
              concurrency_in_use: 3,
              concurrency_limit: 8,
              dials_per_hour: 212,
              eta_seconds: 5 * 86400 + 4 * 3600,
              stall: null,
              other_stalls: [],
              abandonment_rate_24h: { abandoned: 6, answered: 402 },
            }
          : null,
      paused: null,
      stopping: null,
      stopped: null,
      completed:
        spec.status === 'completed'
          ? { completed_at: '2026-11-02T13:30:00Z', duration_seconds: 32 * 86400, reached: 1840, successes: 412, not_reached: 610, dnc: 22, retry_matched: 4 }
          : null,
      draft: null,
    },
    roster: {
      total: 18_400,
      waiting_due_now: 2_310,
      waiting_retry: 1_822,
      waiting_callback: 64,
      on_call: 2,
      in_wrapup: 1,
      completed: 6_905,
      exhausted: 3_410,
      suppressed_dnc: 118,
      suppressed_invalid: 64,
      suppressed_other: 12,
      attempted: 13_420,
      attempts_per_contact: { one: 7_210, two: 3_480, three: 1_690, four_plus: 1_040 },
      dials_placed: 24_870,
      reconciliation: [{ check: 'buckets_sum_to_total', expected: 18_400, actual: 18_400, ok: true }],
    },
    generated_at: GENERATED_AT,
  };
  void agentsOnline;

  // ── Detail files ──────────────────────────────────────────────────────────
  const scope = options.accountScope ?? ACCOUNT.id;
  const prefix = `report-datasets/${TENANT.id}/${scope}/${spec.runId}/`;
  const rowRnd = seeded(spec.seed * 7 + 1);
  type Row = [string, string | null, string, string, string | null, number | null, string, number];
  const attemptRows: Array<{ t: number; row: Row }> = [];
  const sessionRows: Array<{ t: number; row: unknown[] }> = [];
  for (const c of all) {
    const name = c.agent ? (c.agent.name ?? c.agent.id) : null;
    const outcomes: Array<[string, Code | 'none', number]> = [];
    for (const [code, n] of c.codes) for (let i = 0; i < n; i++) outcomes.push(['connected', code, 0]);
    const redialConnected = c.connected - c.conversations;
    for (let i = 0; i < redialConnected; i++) outcomes.push(['connected', 'none', 1]);
    const push = (o: string, n: number) => {
      for (let i = 0; i < n; i++) outcomes.push([o, 'none', 0]);
    };
    push('no_answer', c.noAnswer);
    push('busy', c.busy);
    push('machine', c.machine);
    push('failed', c.failed);
    push('abandoned', c.abandoned);
    const unansweredRedials = c.redials - redialConnected;
    for (let i = 0, j = 0; i < outcomes.length && j < unansweredRedials; i++) {
      if (outcomes[i]![0] === 'no_answer') {
        outcomes[i]![2] = 1;
        j++;
      }
    }
    for (const [outcome, code, redialNo] of outcomes) {
      const t = localInstant(c.date, 9 + rowRnd() * 10, spec.offsetMinutes).getTime();
      const talk = outcome === 'connected' ? between(rowRnd, 15, 320) : null;
      const disposition = outcome !== 'connected' ? null : code === 'none' ? null : code === null ? 'No outcome written' : LABELS[code]!;
      attemptRows.push({
        t,
        row: [iso(t), name, phone(rowRnd, false), outcome, disposition, talk, spec.callerIds[between(rowRnd, 0, spec.callerIds.length - 1)]!, redialNo],
      });
    }
    if (c.agent) {
      const joined = localInstant(c.date, 9 + rowRnd() * 0.5, spec.offsetMinutes).getTime();
      const left = joined + c.online * 1000;
      sessionRows.push({ t: joined, row: [name, iso(joined), iso(left), c.online, rowRnd() < 0.8 ? 'web' : 'mobile', 'Agent left'] });
    }
  }
  attemptRows.sort((a, b) => a.t - b.t);
  sessionRows.sort((a, b) => a.t - b.t);
  const cap = options.attemptsCap;
  const attempts = (cap !== undefined && attemptRows.length > cap ? attemptRows.slice(0, cap) : attemptRows).map((r) => r.row);
  const detailFiles: ReportDetailFile[] = [
    {
      sheet: 'attempts',
      label: 'Attempts',
      key: `${prefix}details-attempts.ndjson.gz`,
      rows: attempts.length,
      truncated: attempts.length < attemptRows.length,
      columns: [
        { key: 'dialed_at', label: 'Dialled at', type: 'datetime' },
        { key: 'agent', label: 'Agent', type: 'text' },
        { key: 'contact', label: 'Contact', type: 'text' },
        { key: 'outcome', label: 'Outcome', type: 'text' },
        { key: 'disposition', label: 'Disposition', type: 'text' },
        { key: 'talk_s', label: 'Talk', type: 'duration_s' },
        { key: 'caller_id', label: 'Caller ID', type: 'text' },
        { key: 'redial_no', label: 'Redial no.', type: 'int' },
      ],
    },
    {
      sheet: 'sessions',
      label: 'Sessions',
      key: `${prefix}details-sessions.ndjson.gz`,
      rows: sessionRows.length,
      truncated: false,
      columns: [
        { key: 'agent', label: 'Agent', type: 'text' },
        { key: 'joined_at', label: 'Joined at', type: 'datetime' },
        { key: 'left_at', label: 'Left at', type: 'datetime' },
        { key: 'duration_s', label: 'Duration', type: 'duration_s' },
        { key: 'client', label: 'Client', type: 'text' },
        { key: 'ended_by', label: 'Ended by', type: 'text' },
      ],
    },
  ];
  const details = new Map<string, Buffer>([
    [detailFiles[0]!.key, ndjsonGz(attempts)],
    [detailFiles[1]!.key, ndjsonGz(sessionRows.map((r) => r.row))],
  ]);

  const agentNames: Record<string, string | null> = {};
  for (const a of [...spec.agents, { id: '2c809102-c3d4-45e6-9071-8c9d0e1f2a3b', name: 'Rohan Desai', load: 0 }]) agentNames[a.id] = a.name;

  const dataset: CampaignReportDataset = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: spec.runId,
    kind: 'campaign',
    audience: 'supervisor',
    generated_at: GENERATED_AT,
    range: { from: FROM, to: TO, timezone: spec.timezone, days: DAYS, start: iso(localInstant(FROM, 0, spec.offsetMinutes)), end: iso(localInstant('2026-11-08', 0, spec.offsetMinutes)) },
    tenant: TENANT,
    account: ACCOUNT,
    subject: { id: spec.id, name: spec.name },
    definitions: campaignDefinitions(),
    notes: [
      'The headline, settings and contact counts describe the campaign as of the time this report was generated; every other figure covers the window.',
      ...(detailFiles[0]!.truncated ? [`The Attempts sheet stops at ${attempts.length.toLocaleString('en-IN')} rows; the totals in this report count every dial.`] : []),
    ],
    detail_files: detailFiles,
    campaign: { id: spec.id, name: spec.name, status: spec.status, timezone: spec.timezone },
    summary,
    activity,
    trends,
    health,
    agent_names: agentNames,
    floors: { campaign_rate_min_first_dials: 25 },
  };
  void weighted;
  return { dataset, details, agentRows };
}

/** The campaign report fixture. */
export function campaignFixture(options: { attemptsCap?: number } = {}): { dataset: CampaignReportDataset; details: Map<string, Buffer> } {
  const { dataset, details } = buildCampaign(SPRING_RECOVERY, options);
  return { dataset, details };
}

/** The server's campaign definitions (`datasets/definitions.ts`), keys, labels and texts as it writes them. */
export function campaignDefinitions() {
  return [
    { key: 'dials', label: 'Dials', text: 'Every call placed in the window, wrap-up redials included.' },
    { key: 'first_dials', label: 'First dials', text: 'Dials that were not wrap-up redials: the connect rate\'s denominator.' },
    { key: 'connected', label: 'Connected', text: 'Calls answered and bridged to an agent, not counting wrap-up redials.' },
    { key: 'conversations', label: 'Conversations', text: 'Calls an agent spoke on, a wrap-up redial chain once: the success rate\'s denominator.' },
    { key: 'connect_rate', label: 'Connect rate', text: 'People reached ÷ first dials. A person is reached when a conversation is closed with an outcome other than voicemail or "no outcome". Shown in words below 25 first dials.' },
    { key: 'success_rate', label: 'Success rate', text: 'Successes ÷ conversations, by the campaign\'s current outcome list. Shown in words below 25 conversations.' },
    { key: 'abandonment_rate', label: 'Abandonment rate', text: 'Answered calls that reached no agent ÷ answered calls. Shown in words below 25 answered calls.' },
    { key: 'talk_time', label: 'Talk time', text: 'The agent\'s leg of each connected call, from the bridge to the end of the call; calls the system closed after a fault are left out.' },
    { key: 'wrapup_time', label: 'Wrap-up time', text: 'Measured wrap-up, over wrap-ups that ended with a submitted outcome, an early return or an automatic return.' },
    { key: 'callbacks_booked', label: 'Callbacks booked', text: 'Calls in the window that ended with a callback time set, counted at the dial that booked them.' },
    { key: 'callbacks_on_time', label: 'Callbacks kept on time', text: 'Of the callbacks due in the window, those whose follow-up call was dialled no later than 15 minutes after the booked time (an early call counts as on time).' },
    { key: 'callbacks_late', label: 'Callbacks kept late', text: 'Callbacks due in the window whose follow-up call was dialled more than 15 minutes after the booked time.' },
    { key: 'callbacks_missed', label: 'Callbacks missed', text: 'Callbacks due in the window that were never dialled because the contact was closed first or the campaign ended.' },
    { key: 'callbacks_pending', label: 'Callbacks pending', text: 'Callbacks due in the window that have not been dialled yet: upcoming while the booked time is still ahead, overdue once it has passed.' },
    { key: 'agents_online_peak', label: 'Agents online (peak)', text: 'The most agents logged in to the campaign at the same moment in the day.' },
    { key: 'best_hours', label: 'Best hours', text: 'Dials and people reached by the hour of day in each contact\'s own time zone (the campaign\'s when the contact has none).' },
    { key: 'stalls', label: 'Stalled minutes', text: 'Minutes in which at least half of the dialler\'s checks on the running campaign placed no call, by the main reason.' },
    { key: 'predial_blocks', label: 'Blocked before dialling', text: 'Contacts the dialler skipped because they were on the Do Not Call list, had an invalid number, or were outside calling hours.' },
    { key: 'recording_share', label: 'Recording share', text: 'Connected calls with a recording ÷ connected calls.' },
  ];
}
