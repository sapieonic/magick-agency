/**
 * The account report fixture: three campaigns built by the campaign builder, summed into the
 * account's rows, totals and days, and a roster folded from the same agent rows (so the agents'
 * dials sum to the campaigns' dials and the benchmark's pooled figures to the rows').
 */
import type { AgencyRosterAgentRowWithName } from '@magick-agency/contracts/api/agency/agency-stats';
import type {
  AccountReportCampaignRow,
  AccountReportDailyRow,
  AccountReportDataset,
  AccountReportFigures,
} from '@magick-agency/contracts/reports';
import { REPORT_DATASET_VERSION } from '@magick-agency/contracts/reports';
import { ACCOUNT, TENANT } from './agent';
import { buildCampaign, campaignDefinitions, DAYS, FLOOR_AGENTS, FROM, GENERATED_AT, NEW_JOINER, SPRING_RECOVERY, TO, type CampaignSpec } from './campaign';
import { gunzipSync } from 'node:zlib';
import { DUBAI_OFFSET, iso, KOLKATA_OFFSET, localDays, localInstant, ndjsonGz, percentile } from './util';

export const ACCOUNT_RUN_ID = '5e2f8a3b-9c4d-4e5f-8a6b-7c8d9e0f1a2b';

const CARD_RENEWALS: CampaignSpec = {
  id: 'c2b3c4d5-e6f7-4081-9b0c-1d2e3f4a5b6c',
  name: 'Card Renewals',
  timezone: 'Asia/Kolkata',
  offsetMinutes: KOLKATA_OFFSET,
  status: 'running',
  agents: [FLOOR_AGENTS[0]!, FLOOR_AGENTS[1]!, FLOOR_AGENTS[3]!, { ...FLOOR_AGENTS[4]!, load: 0.5 }, NEW_JOINER].map((a) => ({ ...a, load: a.load * 0.6 })),
  seed: 57,
  dialsPerDay: 88,
  callerIds: ['+91 80 4718 3301', '+91 80 4718 3302'],
  recordCalls: false,
  runId: ACCOUNT_RUN_ID,
};
const LEGACY_BALANCES: CampaignSpec = {
  id: 'c3c4d5e6-f708-4192-8c1d-2e3f4a5b6c7d',
  name: 'Legacy Balances',
  timezone: 'Asia/Dubai',
  offsetMinutes: DUBAI_OFFSET,
  status: 'running',
  agents: [{ ...FLOOR_AGENTS[2]!, load: 0.35 }, { ...FLOOR_AGENTS[5]!, load: 0.3 }],
  seed: 83,
  dialsPerDay: 70,
  callerIds: ['+971 4 555 0192'],
  recordCalls: true,
  runId: ACCOUNT_RUN_ID,
};

/**
 * `peaks`: carry a peak agents online per day, as a future dataset might. v1 measures none
 * for the account (`agents_online_peak` is null on every day, `docs/reports.md`), so the
 * default is the v1 shape.
 */
export function accountFixture(
  options: { attemptsCap?: number; peaks?: boolean } = { attemptsCap: 5000 },
): { dataset: AccountReportDataset; details: Map<string, Buffer> } {
  const specs = [{ ...SPRING_RECOVERY, runId: ACCOUNT_RUN_ID }, CARD_RENEWALS, LEGACY_BALANCES];
  const built = specs.map((s) => buildCampaign(s, { accountScope: ACCOUNT.id }));

  const rows: AccountReportCampaignRow[] = built.map(({ dataset: d }) => {
    const answered = d.trends.buckets.reduce((s, b) => s + b.answered, 0);
    const abandoned = d.trends.buckets.reduce((s, b) => s + b.abandoned, 0);
    return {
      id: d.campaign.id,
      name: d.campaign.name,
      status: d.campaign.status,
      timezone: d.campaign.timezone,
      calls: d.activity.calls,
      callbacks_booked: d.activity.callbacks.booked,
      abandoned,
      answered,
      abandoned_pct: answered > 0 ? Number(((abandoned / answered) * 100).toFixed(2)) : null,
      recording_connected: d.health.recording.connected,
      recorded: d.health.recording.recorded,
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const totals = sumFigures(rows);

  // Days in the report's zone (Asia/Kolkata): the Dubai campaign's day buckets re-cut by date.
  const days = localDays(FROM, DAYS);
  const daily: AccountReportDailyRow[] = days.map((date, i) => {
    const bs = built.map((b) => b.dataset.trends.buckets[i]!);
    const sum = (k: 'dials' | 'first_dials' | 'connected' | 'conversations' | 'human_connects' | 'successes') => bs.reduce((s, b) => s + b[k], 0);
    const peak = Math.max(...bs.map((b) => b.agents_online_peak));
    return {
      date,
      dials: sum('dials'),
      first_dials: sum('first_dials'),
      connected: sum('connected'),
      conversations: sum('conversations'),
      human_connects: sum('human_connects'),
      successes: sum('successes'),
      // v1: a distinct count across campaigns is not measured. With `peaks`, a hypothetical
      // dataset that measures it, except on two days.
      agents_online_peak:
        !options.peaks || date === '2026-10-22' || date === '2026-10-23' ? null : peak + (bs.filter((b) => b.dials > 0).length > 1 ? 1 : 0),
    };
  });

  // The roster: every agent's rows across the campaigns, folded.
  const byAgent = new Map<string, AgencyRosterAgentRowWithName>();
  const firstDials = new Map<string, number>();
  const humans = new Map<string, number>();
  for (const b of built) {
    for (const a of b.agentRows) {
      if (!a.agent_user_id) continue;
      const r =
        byAgent.get(a.agent_user_id) ??
        ({
          agent_user_id: a.agent_user_id,
          agent_name: a.agent_name,
          attempts: 0,
          connected: 0,
          successes: 0,
          talk_seconds: 0,
          wrapup_seconds: 0,
          connect_rate_pct: null,
          success_rate_pct: null,
          aht_seconds: null,
          campaigns: 0,
          shift_seconds: 0,
          break_seconds: 0,
          occupancy_pct: null,
          last_dialed_at: null,
          rates_reportable: false,
          success_rate_reportable: false,
        } satisfies AgencyRosterAgentRowWithName);
      r.attempts += a.dials;
      r.connected += a.connected;
      r.successes += a.successes;
      r.talk_seconds += a.talk_seconds;
      r.wrapup_seconds += a.wrapup_seconds;
      r.campaigns += 1;
      r.shift_seconds += a.online_seconds;
      r.break_seconds += Object.values(a.state_seconds.break_by_reason).reduce((s: number, v: number) => s + v, 0);
      firstDials.set(a.agent_user_id, (firstDials.get(a.agent_user_id) ?? 0) + a.dials - a.redials);
      humans.set(a.agent_user_id, (humans.get(a.agent_user_id) ?? 0) + a.human_connects);
      byAgent.set(a.agent_user_id, r);
    }
  }
  const r2 = (v: number) => Number(v.toFixed(2));
  const agents = [...byAgent.values()].map((r) => {
    const fd = firstDials.get(r.agent_user_id)!;
    r.connect_rate_pct = fd > 0 ? r2((humans.get(r.agent_user_id)! / fd) * 100) : null;
    r.success_rate_pct = r.connected > 0 ? r2((r.successes / r.connected) * 100) : null;
    r.aht_seconds = r.connected > 0 ? Math.round((r.talk_seconds + r.wrapup_seconds) / r.connected) : null;
    r.occupancy_pct = r.shift_seconds > 0 ? r2(((r.talk_seconds + r.wrapup_seconds) / r.shift_seconds) * 100) : null;
    r.rates_reportable = fd >= 20;
    r.success_rate_reportable = r.rates_reportable && r.connected >= 20;
    r.last_dialed_at = r.agent_user_id === NEW_JOINER.id ? '2026-11-06T11:48:00Z' : '2026-11-07T12:' + String(10 + (r.attempts % 40)).padStart(2, '0') + ':00Z';
    return r;
  });
  agents.sort((a, b) => b.attempts - a.attempts);

  const rated = agents.filter((a) => a.rates_reportable);
  const ratedConn = rated.filter((a) => a.success_rate_reportable);
  const pool = (vals: Array<number | null>) => vals.filter((v): v is number => v !== null);
  const sumA = (k: 'attempts' | 'connected' | 'successes' | 'talk_seconds' | 'wrapup_seconds' | 'shift_seconds' | 'break_seconds') => agents.reduce((s, a) => s + a[k], 0);
  const allFirst = [...firstDials.values()].reduce((s, v) => s + v, 0);
  const allHuman = [...humans.values()].reduce((s, v) => s + v, 0);
  const benchmark: AccountReportDataset['benchmark'] = {
    pool_size: rated.length,
    cohort: {
      agents: agents.length,
      agents_rated: rated.length,
      attempts: sumA('attempts'),
      connected: sumA('connected'),
      successes: sumA('successes'),
      talk_seconds: sumA('talk_seconds'),
      wrapup_seconds: sumA('wrapup_seconds'),
      connect_rate_pct: r2((allHuman / allFirst) * 100),
      success_rate_pct: r2((sumA('successes') / sumA('connected')) * 100),
      aht_seconds: Math.round((sumA('talk_seconds') + sumA('wrapup_seconds')) / sumA('connected')),
      connect_rate: band(pool(rated.map((a) => a.connect_rate_pct))),
      success_rate: band(pool(ratedConn.map((a) => a.success_rate_pct))),
      occupancy_pct: band(pool(rated.map((a) => a.occupancy_pct))),
      aht: band(pool(ratedConn.map((a) => a.aht_seconds))),
      shift_seconds: sumA('shift_seconds'),
      break_seconds: sumA('break_seconds'),
    },
  };

  const health = built.map(({ dataset: d }) => ({
    campaign_id: d.campaign.id,
    auto_pauses: d.health.abandonment.auto_pauses.length,
    stall_minutes_by_reason: d.health.stalls.minutes_by_reason,
    concurrency_limit_minutes: d.health.concurrency_limit_minutes,
    carrier_failures: d.health.carrier_failures,
    our_fault_retired: d.health.our_fault_retired,
    predial_blocks: d.health.predial_blocks,
  }));
  health.sort((a, b) => rows.findIndex((r) => r.id === a.campaign_id) - rows.findIndex((r) => r.id === b.campaign_id));

  // One attempts sheet across the campaigns, capped (RP12) for the fixture.
  const merged: Array<{ t: string; row: unknown[] }> = [];
  for (const [i, b] of built.entries()) {
    const file = b.dataset.detail_files.find((f) => f.sheet === 'attempts')!;
    const lines = gunzipSync(b.details.get(file.key)!).toString('utf8').trim().split('\n');
    for (const line of lines) {
      const r = JSON.parse(line) as unknown[];
      merged.push({ t: r[0] as string, row: [r[0], specs[i]!.name, ...r.slice(1)] });
    }
  }
  merged.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const cap = options.attemptsCap;
  const kept = cap !== undefined && merged.length > cap ? merged.slice(0, cap) : merged;
  const key = `report-datasets/${TENANT.id}/${ACCOUNT.id}/${ACCOUNT_RUN_ID}/details-attempts.ndjson.gz`;
  const details = new Map<string, Buffer>([[key, ndjsonGz(kept.map((k) => k.row))]]);

  const dataset: AccountReportDataset = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: ACCOUNT_RUN_ID,
    kind: 'account',
    audience: 'supervisor',
    generated_at: GENERATED_AT,
    range: { from: FROM, to: TO, timezone: 'Asia/Kolkata', days: DAYS, start: iso(localInstant(FROM, 0, KOLKATA_OFFSET)), end: iso(localInstant('2026-11-08', 0, KOLKATA_OFFSET)) },
    tenant: TENANT,
    account: ACCOUNT,
    subject: { id: ACCOUNT.id, name: ACCOUNT.name },
    // The server's account definitions (`datasets/definitions.ts`): the campaign's, less the per-campaign ones, then its own.
    definitions: [
      ...campaignDefinitions().filter((x) => !['best_hours', 'agents_online_peak', 'stalls', 'callbacks_on_time', 'callbacks_late', 'callbacks_missed', 'callbacks_pending'].includes(x.key)),
      { key: 'totals', label: 'Account totals', text: 'Each figure summed over the covered campaigns; every rate of the totals is worked out again from the summed counts, never averaged across campaigns.' },
      { key: 'agent_rates', label: 'Agent rates', text: 'Each agent\'s connect rate (people reached ÷ first dials), success rate (successes ÷ connected calls) and handle time ((talk + wrap-up) ÷ connected calls) over all the account\'s campaigns. Shown in words below 20 first dials.' },
      { key: 'occupancy', label: 'Occupancy (handling)', text: '(Talk time + wrap-up time) ÷ logged-in time, breaks included, from the recorded state changes.' },
      { key: 'floor_comparison', label: 'Floor comparison', text: 'The middle half (25th to 75th percentile) of the account\'s agents who dialled in the window, over agents with at least 20 first dials.' },
    ],
    notes: [
      'Legacy Balances dials in Asia/Dubai; its activity is shown in this report’s days (Asia/Kolkata).',
      ...(kept.length < merged.length ? [`The Attempts sheet stops at ${kept.length.toLocaleString('en-IN')} rows; the totals in this report count every dial.`] : []),
    ],
    detail_files: [
      {
        sheet: 'attempts',
        label: 'Attempts',
        key,
        rows: kept.length,
        truncated: kept.length < merged.length,
        columns: [
          { key: 'dialed_at', label: 'Dialled at', type: 'datetime' },
          { key: 'campaign', label: 'Campaign', type: 'text' },
          { key: 'agent', label: 'Agent', type: 'text' },
          { key: 'contact', label: 'Contact', type: 'text' },
          { key: 'outcome', label: 'Outcome', type: 'text' },
          { key: 'disposition', label: 'Disposition', type: 'text' },
          { key: 'talk_s', label: 'Talk', type: 'duration_s' },
          { key: 'caller_id', label: 'Caller ID', type: 'text' },
          { key: 'redial_no', label: 'Redial no.', type: 'int' },
        ],
      },
    ],
    campaigns: rows,
    totals,
    agents,
    benchmark,
    daily,
    health,
    floors: { campaign_rate_min_first_dials: 25, agent_rate_min_first_dials: 20 },
  };
  return { dataset, details };
}

function band(values: number[]) {
  return { p25: percentile(values, 0.25), median: percentile(values, 0.5), p75: percentile(values, 0.75) };
}

function sumFigures(rows: AccountReportFigures[]): AccountReportFigures {
  const first = rows[0]!;
  const calls = structuredClone(first.calls);
  for (const r of rows.slice(1)) {
    const c = r.calls;
    calls.dials += c.dials;
    calls.connected += c.connected;
    calls.human_connects += c.human_connects;
    calls.conversations += c.conversations;
    calls.successes += c.successes;
    for (const k of Object.keys(calls.by_outcome) as Array<keyof typeof calls.by_outcome>) calls.by_outcome[k] += c.by_outcome[k];
    for (const k of Object.keys(calls.redials) as Array<keyof typeof calls.redials>) calls.redials[k] += c.redials[k];
    for (const k of Object.keys(calls.agent_retries) as Array<keyof typeof calls.agent_retries>) calls.agent_retries[k] += c.agent_retries[k];
    calls.softphone_calls += c.softphone_calls;
    calls.talk_seconds += c.talk_seconds;
    calls.wrapup_seconds += c.wrapup_seconds;
    calls.wrapup_measured += c.wrapup_measured;
  }
  const abandoned = rows.reduce((s, r) => s + r.abandoned, 0);
  const answered = rows.reduce((s, r) => s + r.answered, 0);
  return {
    calls,
    callbacks_booked: rows.reduce((s, r) => s + r.callbacks_booked, 0),
    abandoned,
    answered,
    abandoned_pct: answered > 0 ? Number(((abandoned / answered) * 100).toFixed(2)) : null,
    recording_connected: rows.reduce((s, r) => s + r.recording_connected, 0),
    recorded: rows.reduce((s, r) => s + r.recorded, 0),
  };
}

