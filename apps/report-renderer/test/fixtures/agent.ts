/**
 * The agent review fixture: one agent's 30 days, SIMULATED call by call, so every block of the
 * dataset is derived from the same events and agrees with every other (daily rows sum to the
 * record, the timeline is that day's state log, outcomes sum to conversations, the detail files
 * hold the very rows the totals count). Seeded: identical on every run.
 */
import type {
  AgentReviewCampaignRow,
  AgentReviewDailyRow,
  AgentReviewDataset,
  AgentReviewOutcomeRow,
  AgentReviewTimelineSegment,
  ReportAudience,
  ReportDetailFile,
  ReportTimelineState,
} from '@magick-agency/contracts/reports';
import { REPORT_DATASET_VERSION } from '@magick-agency/contracts/reports';
import { between, iso, isoWeekday, localDays, localInstant, ndjsonGz, phone, round1, seeded, weighted, KOLKATA_OFFSET } from './util';

export const TENANT = { id: '6f1c2a3e-9b0d-4c55-8e21-2d8f9a0b7c11', name: 'Sapieonic Demo' };
export const ACCOUNT = { id: '0b8d3c42-5e6f-4a71-9c2d-31e4f5a6b7c8', name: 'North Collections' };
export const AGENT = { user_id: 'a7e3b9d1-2c4f-4e8a-b6d0-9f1e2a3b4c5d', name: 'Priya Sharma' };
export const CAMPAIGNS = [
  { id: 'c1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b', name: 'Spring Recovery', timezone: 'Asia/Kolkata' },
  { id: 'c2b3c4d5-e6f7-4081-9b0c-1d2e3f4a5b6c', name: 'Card Renewals', timezone: 'Asia/Kolkata' },
  { id: 'c3c4d5e6-f708-4192-8c1d-2e3f4a5b6c7d', name: 'Legacy Balances', timezone: 'Asia/Dubai' },
] as const;
const RECORDS_CALLS: Record<string, boolean> = { [CAMPAIGNS[0].id]: true, [CAMPAIGNS[1].id]: false, [CAMPAIGNS[2].id]: true };

export const AGENT_RUN_ID = '9d2f6a1b-3c4e-4f5a-8b7c-6d5e4f3a2b1c';
const FROM = '2026-10-09';
const DAYS = 30;
const ZONE = 'Asia/Kolkata';

type Code = 'ptp' | 'paid' | 'callback' | 'not_interested' | 'wrong_number' | 'dispute' | 'voicemail' | null;
const CODES: ReadonlyArray<readonly [Code, number]> = [
  ['ptp', 16],
  ['paid', 4],
  ['callback', 12],
  ['not_interested', 30],
  ['wrong_number', 7.5],
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
  null: 'No outcome written',
};
const SUCCESS = new Set<Code>(['ptp', 'paid']);
const TALK: Record<string, readonly [number, number]> = {
  ptp: [170, 330],
  paid: [90, 200],
  callback: [90, 200],
  not_interested: [55, 150],
  wrong_number: [18, 60],
  dispute: [150, 320],
  voicemail: [12, 35],
  null: [30, 110],
};
const BREAK_LABELS: Record<string, string> = {
  lunch: 'Lunch',
  tea: 'Tea',
  soft_phone: 'Soft phone',
  device_away: 'App in the background',
};

interface Segment {
  start: number;
  end: number;
  state: ReportTimelineState;
  reason: string | null;
  campaign: string | null;
}
interface Call {
  dialedAt: number;
  campaign: string;
  outcome: 'connected' | 'no_answer' | 'busy' | 'machine' | 'agent_disconnected';
  code: Code;
  talk: number | null;
  wrapup: number | null;
  wrapupMeasured: boolean;
  redialNo: number;
  callbackAt: number | null;
  conversation: boolean;
  human: boolean;
  success: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed' | null;
  phone: string;
}
interface Session {
  campaign: string;
  joined: number;
  left: number;
  endedBy: 'agent' | 'connection_lost' | 'supervisor';
  client: 'web' | 'mobile';
}

export interface AgentFixture {
  dataset: AgentReviewDataset;
  /** Detail file bodies (gzipped NDJSON) by key. */
  details: Map<string, Buffer>;
}

export interface AgentFixtureOptions {
  audience?: ReportAudience;
  /** Cut the calls sheet at this many rows and mark it truncated (RP12). */
  callsCap?: number;
}

/** Build the agent review fixture. */
export function agentFixture(options: AgentFixtureOptions = {}): AgentFixture {
  const audience = options.audience ?? 'supervisor';
  const self = audience === 'self';
  const rnd = seeded(20261108);
  const phoneRnd = seeded(77);
  const days = localDays(FROM, DAYS);
  const at = (date: string, h: number) => Math.round(localInstant(date, h, KOLKATA_OFFSET).getTime() / 1000) * 1000;

  const segments: Segment[] = [];
  const calls: Call[] = [];
  const sessions: Session[] = [];
  const dailyRows: AgentReviewDailyRow[] = [];
  let dropsTotal = 0;
  let redialsPlaced = 0;
  let redialsConnected = 0;
  let softphoneCalls = 0;

  for (const date of days) {
    const wd = isoWeekday(date);
    const halfDay = date === '2026-10-17' || date === '2026-10-31';
    const worked = (wd <= 5 && date !== '2026-10-21') || halfDay;
    const row: AgentReviewDailyRow = {
      date,
      first_in: null,
      last_out: null,
      sessions: 0,
      drops: 0,
      station_s: 0,
      on_call_s: 0,
      wrapup_s: 0,
      available_s: 0,
      break_s: 0,
      dials: 0,
      first_dials: 0,
      connected: 0,
      conversations: 0,
      human_connects: 0,
      successes: 0,
      talk_s: 0,
    };
    if (!worked) {
      dailyRows.push(row);
      continue;
    }
    // The day's sessions: [start, end, campaign, endedBy].
    const dayStart = halfDay ? 9.5 + rnd() * 0.3 : 9 + rnd() * 0.58;
    const dayEnd = halfDay ? 13.3 + rnd() * 0.4 : 17.65 + rnd() * 0.45;
    const plan: Array<{ s: number; e: number; campaign: string; endedBy: Session['endedBy'] }> = [];
    const split = halfDay ? 0 : weighted(rnd, [[0, 5], [1, 3], [2, 1.2]] as const);
    if (split === 0) {
      plan.push({ s: dayStart, e: dayEnd, campaign: CAMPAIGNS[0].id, endedBy: 'agent' });
    } else if (split === 1) {
      // A lunch logout: two sessions, the afternoon one often on Card Renewals.
      const lunch = 13 + rnd() * 0.5;
      plan.push({ s: dayStart, e: lunch, campaign: CAMPAIGNS[0].id, endedBy: 'agent' });
      plan.push({ s: lunch + 0.55 + rnd() * 0.2, e: dayEnd, campaign: rnd() < 0.65 ? CAMPAIGNS[1].id : CAMPAIGNS[0].id, endedBy: 'agent' });
    } else {
      // A dropped connection mid-morning, then a lunch logout.
      const drop = 10.5 + rnd() * 1.2;
      const lunch = 13 + rnd() * 0.5;
      plan.push({ s: dayStart, e: drop, campaign: CAMPAIGNS[0].id, endedBy: 'connection_lost' });
      plan.push({ s: drop + 0.04 + rnd() * 0.06, e: lunch, campaign: CAMPAIGNS[0].id, endedBy: 'agent' });
      plan.push({ s: lunch + 0.55 + rnd() * 0.2, e: dayEnd, campaign: CAMPAIGNS[1].id, endedBy: 'agent' });
    }
    if (date === '2026-10-27') {
      // A short afternoon on Legacy Balances (too few dials for its rates to be quoted).
      const last = plan[plan.length - 1]!;
      const legacyStart = last.e;
      last.e = legacyStart - 0.6;
      plan.push({ s: last.e + 0.05, e: legacyStart, campaign: CAMPAIGNS[2].id, endedBy: 'agent' });
    }

    for (const p of plan) {
      const joined = at(date, p.s);
      const left = at(date, p.e);
      sessions.push({ campaign: p.campaign, joined, left, endedBy: p.endedBy, client: rnd() < 0.8 ? 'web' : 'mobile' });
      row.sessions += 1;
      if (p.endedBy === 'connection_lost') row.drops += 1;
      const breaks: Array<{ at: number; len: number; reason: string }> = [];
      const addBreak = (h: number, minLen: number, maxLen: number, reason: string) => {
        const t = at(date, h);
        const len = between(rnd, minLen, maxLen);
        if (t > joined + 600_000 && t + len * 1000 < left - 900_000) breaks.push({ at: t, len, reason });
      };
      addBreak(11.15 + rnd() * 0.3, 600, 1080, 'tea');
      if (split === 0) addBreak(13.1 + rnd() * 0.4, 2100, 3000, 'lunch');
      addBreak(15.9 + rnd() * 0.4, 540, 900, 'tea');
      if (rnd() < 0.35) addBreak(12 + rnd() * 3.5, 180, 480, 'soft_phone');
      if (rnd() < 0.15) addBreak(10 + rnd() * 6, 90, 300, 'device_away');
      breaks.sort((a, b) => a.at - b.at);

      let t = joined;
      const push = (state: ReportTimelineState, len: number, reason: string | null = null) => {
        const end = t + len * 1000;
        const prev = segments[segments.length - 1];
        if (prev && prev.end === t && prev.state === state && prev.reason === reason && prev.campaign === p.campaign) prev.end = end;
        else segments.push({ start: t, end, state, reason, campaign: p.campaign });
        t = end;
      };
      let lastConnected: Call | null = null;
      while (t < left - 600_000) {
        const nextBreak = breaks[0];
        if (nextBreak && t >= nextBreak.at) {
          breaks.shift();
          push('break', nextBreak.len, nextBreak.reason);
          if (nextBreak.reason === 'soft_phone') softphoneCalls += 1;
          continue;
        }
        // Idle while the dialer rings numbers; some of those dials are not answered.
        const gap = Math.min(between(rnd, 15, 140), Math.max(1, Math.round((left - t) / 1000) - 1));
        const unanswered = weighted(rnd, [[0, 45], [1, 35], [2, 15], [3, 5]] as const);
        for (let i = 0; i < unanswered; i++) {
          calls.push(blankDial(t + ((i + 1) * gap * 1000) / (unanswered + 2), p.campaign, weighted(rnd, [['no_answer', 6], ['busy', 2], ['machine', 2]] as const), 0, self));
          row.dials += 1;
          row.first_dials += 1;
        }
        push('available', gap);
        // A conversation.
        const code = weighted(rnd, CODES);
        const [lo, hi] = TALK[String(code)]!;
        const talk = between(rnd, lo, hi);
        const wrap = between(rnd, 8, 70);
        const measured = rnd() < 0.95;
        const human = code !== 'voicemail' && code !== null;
        const recorded = RECORDS_CALLS[p.campaign]!;
        const call: Call = {
          dialedAt: t - 6000,
          campaign: p.campaign,
          outcome: 'connected',
          code,
          talk,
          wrapup: measured ? wrap : null,
          wrapupMeasured: measured,
          redialNo: 0,
          callbackAt: null,
          conversation: true,
          human,
          success: SUCCESS.has(code),
          sentiment: recorded && human && rnd() < 0.55 ? weighted(rnd, [['positive', 52], ['neutral', 28], ['negative', 12], ['mixed', 8]] as const) : null,
          phone: phone(phoneRnd, self),
        };
        calls.push(call);
        lastConnected = call;
        row.dials += 1;
        row.first_dials += 1;
        row.connected += 1;
        row.conversations += 1;
        if (human) row.human_connects += 1;
        if (call.success) row.successes += 1;
        row.talk_s += talk;
        push('on_call', talk + 2);
        push('wrapup', wrap);
        // A wrap-up redial now and then; it is a dial but not a new conversation.
        if (rnd() < 0.03) {
          redialsPlaced += 1;
          row.dials += 1;
          if (rnd() < 0.4) {
            redialsConnected += 1;
            const redialTalk = between(rnd, 30, 120);
            const redialWrap = between(rnd, 8, 40);
            calls.push({ ...call, dialedAt: t - 3000, talk: redialTalk, wrapup: redialWrap, redialNo: 1, conversation: false, sentiment: null, callbackAt: null });
            row.connected += 1;
            row.talk_s += redialTalk;
            push('on_call', redialTalk + 2);
            push('wrapup', redialWrap);
          } else {
            calls.push(blankDial(t - 3000, p.campaign, 'no_answer', 1, self));
          }
        }
        if (code === 'callback') {
          // Booked for the next working morning or afternoon.
          call.callbackAt = call.dialedAt + (18 + between(rnd, 0, 6)) * 3_600_000;
        }
      }
      if (t < left) push('available', (left - t) / 1000);
      if (p.endedBy === 'connection_lost' && lastConnected) {
        // The call in progress when the connection dropped.
        lastConnected.outcome = 'agent_disconnected';
        if (lastConnected.human) row.human_connects -= 1;
        if (lastConnected.success) row.successes -= 1;
        lastConnected.code = null;
        lastConnected.human = false;
        lastConnected.success = false;
        lastConnected.sentiment = null;
        lastConnected.callbackAt = null;
      }
    }
    dropsTotal += row.drops;
    row.first_in = iso(sessions.filter((s) => dayOf(s.joined) === date)[0]!.joined);
    row.last_out = iso(sessions.filter((s) => dayOf(s.joined) === date).at(-1)!.left);
    for (const s of segments) {
      if (dayOf(s.start) !== date) continue;
      const len = Math.round((s.end - s.start) / 1000);
      if (s.state === 'on_call') row.on_call_s += len;
      else if (s.state === 'wrapup') row.wrapup_s += len;
      else if (s.state === 'available') row.available_s += len;
      else if (s.state === 'break') row.break_s += len;
    }
    row.station_s = row.on_call_s + row.wrapup_s + row.available_s + row.break_s;
    dailyRows.push(row);
  }

  // ── Window figures, every one a sum of the rows above ──────────────────────
  const sum = (k: keyof AgentReviewDailyRow) => dailyRows.reduce((s, r) => s + (r[k] as number), 0);
  const attempts = sum('dials');
  const connected = sum('connected');
  const successes = sum('successes');
  const talkSeconds = sum('talk_s');
  const firstDials = sum('first_dials');
  const humanConnects = sum('human_connects');
  const conversations = sum('conversations');
  const wrapupMeasured = calls.reduce((s, c) => s + (c.wrapupMeasured && c.wrapup ? c.wrapup : 0), 0);
  const byState = { available: sum('available_s'), on_call: sum('on_call_s'), wrapup: sum('wrapup_s'), break: sum('break_s') };
  const station = byState.available + byState.on_call + byState.wrapup + byState.break;
  const r2 = (v: number) => Number(v.toFixed(2));

  const record: AgentReviewDataset['record'] = {
    attempts,
    connected,
    connect_rate_pct: firstDials > 0 ? r2((humanConnects / firstDials) * 100) : null,
    successes,
    success_rate_pct: connected > 0 ? r2((successes / connected) * 100) : null,
    talk_seconds: talkSeconds,
    wrapup_seconds: wrapupMeasured,
    aht_seconds: connected > 0 ? Math.round((talkSeconds + wrapupMeasured) / connected) : null,
    campaigns: 3,
    occupancy: {
      shift_seconds: station,
      by_state: { offline: 0, available: byState.available, reserved: 0, on_call: byState.on_call, wrapup: byState.wrapup, break: byState.break },
    },
  };

  const perCampaign: AgentReviewCampaignRow[] = CAMPAIGNS.map((c) => {
    const cc = calls.filter((x) => x.campaign === c.id);
    const fd = cc.filter((x) => x.redialNo === 0).length;
    const hc = cc.filter((x) => x.conversation && x.human).length;
    return {
      campaign_id: c.id,
      campaign_name: c.name,
      attempts: cc.length,
      connected: cc.filter((x) => x.outcome === 'connected' || x.outcome === 'agent_disconnected').length,
      successes: cc.filter((x) => x.conversation && x.success).length,
      talk_seconds: cc.reduce((s, x) => s + (x.talk ?? 0), 0),
      wrapup_seconds: cc.reduce((s, x) => s + (x.wrapupMeasured && x.wrapup ? x.wrapup : 0), 0),
      human_connects: hc,
      first_dials: fd,
      connect_rate_pct: fd > 0 ? r2((hc / fd) * 100) : null,
      rates_reportable: fd >= 20,
    };
  });

  const occupancyPct = r2(((talkSeconds + wrapupMeasured) / station) * 100);
  const rosterRow: AgentReviewDataset['roster_row'] = {
    agent_user_id: AGENT.user_id,
    agent_name: AGENT.name,
    attempts,
    connected,
    successes,
    talk_seconds: talkSeconds,
    wrapup_seconds: wrapupMeasured,
    connect_rate_pct: record.connect_rate_pct,
    success_rate_pct: record.success_rate_pct,
    aht_seconds: record.aht_seconds,
    campaigns: 3,
    shift_seconds: station,
    break_seconds: byState.break,
    occupancy_pct: occupancyPct,
    last_dialed_at: iso(calls.at(-1)!.dialedAt),
    rates_reportable: firstDials >= 20,
    success_rate_reportable: connected >= 20,
  };

  // Outcomes over conversations.
  const convs = calls.filter((c) => c.conversation);
  const byCode = new Map<Code, { n: number; talk: number }>();
  for (const c of convs) {
    const e = byCode.get(c.code) ?? { n: 0, talk: 0 };
    e.n += 1;
    e.talk += c.talk ?? 0;
    byCode.set(c.code, e);
  }
  for (const c of calls.filter((x) => x.redialNo > 0 && x.talk)) {
    const e = byCode.get(c.code);
    if (e) e.talk += c.talk ?? 0;
  }
  const outcomes: AgentReviewOutcomeRow[] = [...byCode.entries()]
    .map(([code, e]) => ({
      code,
      label: LABELS[String(code)]!,
      is_success: SUCCESS.has(code),
      conversations: e.n,
      share_pct: r2((e.n / conversations) * 100),
      avg_talk_s: Math.round(e.talk / e.n),
    }))
    .sort((a, b) => b.conversations - a.conversations);

  // Callbacks booked by this agent, classed as Insights does.
  const end = Date.parse('2026-11-07T18:30:00Z');
  const cbRnd = seeded(404);
  const callbacks = { booked: 0, on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 };
  const callbackRows: Array<{ booked: number; due: number; followed: number | null; cls: string; campaign: string }> = [];
  for (const c of convs.filter((x) => x.callbackAt !== null)) {
    callbacks.booked += 1;
    const due = c.callbackAt!;
    let cls: keyof typeof callbacks;
    let followed: number | null = null;
    if (due >= end) cls = 'pending_future';
    else {
      cls = weighted(cbRnd, [['on_time', 86], ['late', 9], ['missed', 3], ['pending_due', 2]] as const);
      if (cls === 'on_time') followed = due + between(cbRnd, -300, 840) * 1000;
      if (cls === 'late') followed = due + between(cbRnd, 1000, 7200) * 1000;
    }
    callbacks[cls] += 1;
    callbackRows.push({ booked: c.dialedAt, due, followed, cls, campaign: c.campaign });
  }

  // Timeline: the day with the most station time, the latest on a tie.
  let best: AgentReviewDailyRow | null = null;
  for (const r of dailyRows) if (r.station_s > 0 && (!best || r.station_s >= best.station_s)) best = r;
  let timeline: AgentReviewDataset['timeline'] = null;
  if (best) {
    const dayStart = at(best.date, 0);
    const dayEnd = at(best.date, 24);
    const out: AgentReviewTimelineSegment[] = [];
    let cursor = dayStart;
    for (const s of segments.filter((x) => x.start >= dayStart && x.end <= dayEnd)) {
      if (s.start > cursor) out.push({ start: iso(cursor), end: iso(s.start), state: 'offline', break_reason: null });
      out.push({ start: iso(s.start), end: iso(s.end), state: s.state, break_reason: s.reason });
      cursor = s.end;
    }
    if (cursor < dayEnd) out.push({ start: iso(cursor), end: iso(dayEnd), state: 'offline', break_reason: null });
    timeline = { date: best.date, segments: out };
  }

  const breakByReason = new Map<string, number>();
  for (const s of segments.filter((x) => x.state === 'break')) {
    breakByReason.set(s.reason!, (breakByReason.get(s.reason!) ?? 0) + Math.round((s.end - s.start) / 1000));
  }

  const analysed = calls.filter((c) => c.sentiment !== null);
  const quality = self
    ? null
    : {
        analysed_calls: analysed.length,
        sentiment: {
          positive: analysed.filter((c) => c.sentiment === 'positive').length,
          neutral: analysed.filter((c) => c.sentiment === 'neutral').length,
          negative: analysed.filter((c) => c.sentiment === 'negative').length,
          mixed: analysed.filter((c) => c.sentiment === 'mixed').length,
        },
      };

  const benchmark: AgentReviewDataset['benchmark'] = self
    ? null
    : {
        pool_size: 41,
        cohort: {
          agents: 46,
          agents_rated: 41,
          attempts: 98_412,
          connected: 52_117,
          successes: 8_604,
          talk_seconds: 8_201_330,
          wrapup_seconds: 1_486_220,
          connect_rate_pct: 41.62,
          success_rate_pct: 16.51,
          aht_seconds: 186,
          connect_rate: { p25: 37.4, median: 41.9, p75: 46.2 },
          success_rate: { p25: 12.8, median: 15.9, p75: 19.4 },
          occupancy_pct: { p25: 38.5, median: 44.1, p75: 49.8 },
          aht: { p25: 162, median: 184, p75: 211 },
          shift_seconds: 21_602_400,
          break_seconds: 2_861_000,
        },
      };

  // ── Detail files ───────────────────────────────────────────────────────────
  const campaignName = (id: string | null) => CAMPAIGNS.find((c) => c.id === id)?.name ?? null;
  const prefix = `report-datasets/${TENANT.id}/${ACCOUNT.id}/${AGENT_RUN_ID}/`;
  const sessionRows = sessions.map((s) => [
    campaignName(s.campaign),
    iso(s.joined),
    iso(s.left),
    Math.round((s.left - s.joined) / 1000),
    s.client,
    s.endedBy === 'connection_lost' ? 'Connection lost' : 'Agent left',
  ]);
  const stateRows: unknown[][] = [];
  let prevState: string = 'offline';
  for (const s of segments) {
    stateRows.push([iso(s.start), campaignName(s.campaign), prevState, s.state, s.reason ? BREAK_LABELS[s.reason] ?? s.reason : null, Math.round((s.end - s.start) / 1000)]);
    prevState = s.state;
  }
  const callsSorted = [...calls].sort((a, b) => a.dialedAt - b.dialedAt);
  const allCallRows = callsSorted.map((c) => {
    const base: unknown[] = [
      iso(c.dialedAt),
      campaignName(c.campaign),
      c.phone,
      c.outcome,
      c.outcome === 'connected' || c.outcome === 'agent_disconnected' ? LABELS[String(c.code)] : null,
      c.talk,
      c.wrapup,
      c.redialNo,
      c.callbackAt ? iso(c.callbackAt) : null,
    ];
    if (!self) base.push(c.talk !== null ? RECORDS_CALLS[c.campaign]! : false, c.sentiment);
    return base;
  });
  const cap = options.callsCap;
  const callRows = cap !== undefined && allCallRows.length > cap ? allCallRows.slice(0, cap) : allCallRows;

  const callColumns: ReportDetailFile['columns'] = [
    { key: 'dialed_at', label: 'Dialled at', type: 'datetime' },
    { key: 'campaign', label: 'Campaign', type: 'text' },
    { key: 'contact', label: 'Contact', type: 'text' },
    { key: 'outcome', label: 'Outcome', type: 'text' },
    { key: 'disposition', label: 'Disposition', type: 'text' },
    { key: 'talk_s', label: 'Talk', type: 'duration_s' },
    { key: 'wrapup_s', label: 'Wrap-up', type: 'duration_s' },
    { key: 'redial_no', label: 'Redial no.', type: 'int' },
    { key: 'callback_at', label: 'Callback at', type: 'datetime' },
  ];
  if (!self) callColumns.push({ key: 'recorded', label: 'Recorded', type: 'bool' }, { key: 'sentiment', label: 'Sentiment', type: 'text' });

  const detailFiles: ReportDetailFile[] = [
    {
      sheet: 'sessions',
      label: 'Sessions',
      key: `${prefix}details-sessions.ndjson.gz`,
      rows: sessionRows.length,
      truncated: false,
      columns: [
        { key: 'campaign', label: 'Campaign', type: 'text' },
        { key: 'joined_at', label: 'Joined at', type: 'datetime' },
        { key: 'left_at', label: 'Left at', type: 'datetime' },
        { key: 'duration_s', label: 'Duration', type: 'duration_s' },
        { key: 'client', label: 'Client', type: 'text' },
        { key: 'ended_by', label: 'Ended by', type: 'text' },
      ],
    },
    {
      sheet: 'state_log',
      label: 'State log',
      key: `${prefix}details-state_log.ndjson.gz`,
      rows: stateRows.length,
      truncated: false,
      columns: [
        { key: 'at', label: 'At', type: 'datetime' },
        { key: 'campaign', label: 'Campaign', type: 'text' },
        { key: 'from_state', label: 'From state', type: 'text' },
        { key: 'to_state', label: 'To state', type: 'text' },
        { key: 'break_reason', label: 'Break reason', type: 'text' },
        { key: 'seconds_in_state', label: 'Time in state', type: 'duration_s' },
      ],
    },
    {
      sheet: 'calls',
      label: 'Calls',
      key: `${prefix}details-calls.ndjson.gz`,
      rows: callRows.length,
      truncated: callRows.length < allCallRows.length,
      columns: callColumns,
    },
  ];
  const details = new Map<string, Buffer>([
    [detailFiles[0]!.key, ndjsonGz(sessionRows)],
    [detailFiles[1]!.key, ndjsonGz(stateRows)],
    [detailFiles[2]!.key, ndjsonGz(callRows)],
  ]);

  const notes: string[] = [
    'Time on station counts this account’s campaigns only; sessions on other accounts are left out.',
  ];
  if (detailFiles[2]!.truncated) notes.push(`The Calls sheet stops at ${callRows.length.toLocaleString('en-IN')} rows; the totals in this report count every call.`);

  const dataset: AgentReviewDataset = {
    dataset_version: REPORT_DATASET_VERSION,
    run_id: AGENT_RUN_ID,
    kind: 'agent',
    audience,
    generated_at: '2026-11-08T03:30:00Z',
    range: { from: FROM, to: '2026-11-07', timezone: ZONE, days: DAYS, start: '2026-10-08T18:30:00Z', end: '2026-11-07T18:30:00Z' },
    tenant: TENANT,
    account: ACCOUNT,
    subject: { id: AGENT.user_id, name: AGENT.name },
    definitions: agentDefinitions(self),
    notes,
    detail_files: detailFiles,
    agent: AGENT,
    campaigns: CAMPAIGNS.map((c) => ({ ...c })),
    record,
    roster_row: rosterRow,
    benchmark,
    occupancy: {
      handling_pct: occupancyPct,
      on_call_pct: r2((byState.on_call / station) * 100),
      on_call_pct_excl_break: r2((byState.on_call / (station - byState.break)) * 100),
    },
    presence: {
      days_worked: dailyRows.filter((r) => r.station_s > 0).length,
      station_seconds: station,
      by_state: byState,
      break_by_reason: [...breakByReason.entries()]
        .map(([reason, seconds]) => ({ reason, label: BREAK_LABELS[reason] ?? reason, seconds }))
        .sort((a, b) => b.seconds - a.seconds),
      drops: dropsTotal,
    },
    daily: dailyRows,
    timeline,
    outcomes,
    per_campaign: perCampaign,
    follow_through: {
      callbacks,
      redials_placed: redialsPlaced,
      redials_connected: redialsConnected,
      agent_retries: 11,
      overrides_used: 4,
      dnc_marked: 9,
      softphone_calls: softphoneCalls,
    },
    quality,
    floors: { agent_rate_min_first_dials: 20 },
  };
  void round1;
  void callbackRows;
  return { dataset, details };

  function dayOf(ms: number): string {
    return new Date(ms + KOLKATA_OFFSET * 60_000).toISOString().slice(0, 10);
  }
}

function blankDial(t: number, campaign: string, outcome: Call['outcome'], redialNo: number, masked: boolean): Call {
  return {
    dialedAt: Math.round(t),
    campaign,
    outcome,
    code: null,
    talk: null,
    wrapup: null,
    wrapupMeasured: false,
    redialNo,
    callbackAt: null,
    conversation: false,
    human: false,
    success: false,
    sentiment: null,
    phone: phone(seeded(Math.round(t) % 100000), masked),
  };
}

function agentDefinitions(self: boolean) {
  const defs = [
    { key: 'station_time', label: 'Time on station', text: 'Logged-in time on this account’s campaigns: idle, on a call, wrap-up and breaks. Logged-out gaps are not counted.' },
    { key: 'talk_time', label: 'Talking (agent leg)', text: 'From the moment the call was bridged to the agent until it ended. Calls the reaper closed are left out, so this can be a little lower than time in the on-call state.' },
    { key: 'occupancy', label: 'Occupancy', text: 'Talk plus measured wrap-up, divided by time on station (breaks included). This is the roster’s figure, the one compared with the floor.' },
    { key: 'on_call_share', label: 'On a call (state time)', text: 'Time in the on-call state divided by time on station, shown with and without breaks in the denominator.' },
    { key: 'connect_rate', label: 'Connect rate', text: 'People reached (conversations not coded voicemail and with an outcome written) divided by first dials (dials that were not wrap-up redials). Not quoted below 20 first dials.' },
    { key: 'success_rate', label: 'Success rate', text: 'Calls closed with a success outcome divided by connected calls. Not quoted below 20 connected calls.' },
    { key: 'aht', label: 'Average handle time', text: 'Talk plus measured wrap-up, divided by connected calls.' },
    { key: 'conversations', label: 'Conversations', text: 'One per person spoken to: a wrap-up redial to the same person counts once.' },
    { key: 'drops', label: 'Drops', text: 'Station connections that ended without the agent leaving (a lost network or a closed app).' },
    { key: 'callbacks', label: 'Callbacks', text: 'Callbacks the agent booked. On time means dialled within 15 minutes of the booked time, or earlier.' },
    { key: 'catalog', label: 'Outcome labels', text: 'Outcomes carry each campaign’s current labels: editing a campaign’s outcomes re-labels its history.' },
  ];
  if (!self) {
    defs.push(
      { key: 'floor_bands', label: 'Floor bands', text: 'The middle half (25th to 75th percentile) and median of agents on this account over the same window, counting only agents with at least 20 first dials.' },
      { key: 'sentiment', label: 'Sentiment', text: 'From call analysis of recorded calls only: positive, neutral, negative or mixed, each counted on its own; calls that were not recorded or analysed are not counted.' },
    );
  }
  return defs;
}

/**
 * The agent review with its representative day moved to a clock change in Europe/London:
 * `back` is Sunday 25 Oct 2026 (BST to GMT at 02:00, a 25-hour day: 01:00–02:00 happens twice),
 * `forward` is Sunday 29 Mar 2026 (GMT to BST at 01:00, a 23-hour day: no 01:00–02:00). The
 * shift crosses the change; segments run from local midnight to the next, offline between.
 */
export function agentClockChangeFixture(change: 'back' | 'forward'): AgentReviewDataset {
  const d = structuredClone(agentFixture().dataset);
  const back = change === 'back';
  const date = back ? '2026-10-25' : '2026-03-29';
  // Local midnight to the next local midnight, in UTC.
  const [dayStart, dayEnd] = back ? ['2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z'] : ['2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z'];
  const work: Array<[string, string, ReportTimelineState]> = back
    ? [
        ['2026-10-25T00:10:00Z', '2026-10-25T00:40:00Z', 'available'], // 01:10–01:40 BST
        ['2026-10-25T00:40:00Z', '2026-10-25T01:20:00Z', 'on_call'], // 01:40 BST – 01:20 GMT, across the change
        ['2026-10-25T01:20:00Z', '2026-10-25T01:30:00Z', 'wrapup'],
        ['2026-10-25T01:30:00Z', '2026-10-25T03:00:00Z', 'available'],
        ['2026-10-25T03:00:00Z', '2026-10-25T03:30:00Z', 'break'],
        ['2026-10-25T03:30:00Z', '2026-10-25T05:00:00Z', 'on_call'],
        ['2026-10-25T19:00:00Z', '2026-10-25T22:30:00Z', 'on_call'], // 19:00–22:30 GMT: 20–23.5 hours in
      ]
    : [
        ['2026-03-29T00:20:00Z', '2026-03-29T00:50:00Z', 'available'], // 00:20–00:50 GMT
        ['2026-03-29T00:50:00Z', '2026-03-29T01:40:00Z', 'on_call'], // 00:50 GMT – 02:40 BST, across the change
        ['2026-03-29T01:40:00Z', '2026-03-29T04:00:00Z', 'available'],
        ['2026-03-29T19:00:00Z', '2026-03-29T22:00:00Z', 'on_call'], // 20:00–23:00 BST: 19–22 hours in
      ];
  const segments: AgentReviewTimelineSegment[] = [];
  let cursor = dayStart;
  for (const [start, end, state] of work) {
    if (start > cursor) segments.push({ start: cursor, end: start, state: 'offline', break_reason: null });
    segments.push({ start, end, state, break_reason: state === 'break' ? 'Lunch' : null });
    cursor = end;
  }
  if (cursor < dayEnd) segments.push({ start: cursor, end: dayEnd, state: 'offline', break_reason: null });
  d.range.timezone = 'Europe/London';
  d.timeline = { date, segments };
  return d;
}
