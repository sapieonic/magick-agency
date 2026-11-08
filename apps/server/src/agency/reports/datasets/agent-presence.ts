/**
 * The agent review's time blocks, folded from the agent's state intervals (the occupancy
 * intervals, `ReportStateIntervalRow`) and their attempt days: the day rows in the REPORT's zone,
 * the window's presence and break reasons, and the representative day's timeline. Pure, so the
 * unit suite pins every rule (docs/reports.md "Datasets").
 *
 * Rules:
 *  - `reserved` is folded into `available` (a call being connected to an idle agent), and any
 *    state outside the four reported ones is dropped, never invented (`foldOccupancy`'s rule).
 *  - An interval crossing midnight is split at the local midnight of `range.timezone`; every
 *    second lands in exactly one day.
 *  - Seconds are whole: each column is rounded across the days so the days sum to the window's
 *    rounded total (`roundPreservingSum`); `presence.by_state` IS that sum, and break reasons are
 *    rounded the same way to sum to it.
 *  - `first_in` / `last_out`: the first logged-in instant and the last of the day, clipped to the
 *    day (a shift running through midnight starts the next day at 00:00).
 *  - The timeline day is the day with the most logged-in seconds, the latest on a tie; its
 *    segments run from the day's start to its end, clipped to `clipEnd` (the window's end, or now
 *    when that is earlier: the future is not shown as offline time), `offline` filling every gap,
 *    adjacent equal segments merged.
 */
import type {
  AgentReviewDailyRow,
  AgentReviewTimeline,
  AgentReviewTimelineSegment,
  ReportStateSeconds,
  ReportTimelineState,
} from '@magick-agency/contracts/reports';
import type { LocalDay } from './shared.js';
import { roundPreservingSum } from './shared.js';

/** One logged-in interval (offline excluded by the read). */
export interface PresenceInterval {
  session_id: string;
  state: string;
  break_reason: string | null;
  started: Date;
  ended: Date;
}

type ReportedState = keyof ReportStateSeconds;

/** The reported state of a stored one, or null for a state that is not reported. */
export function reportedState(state: string): ReportedState | null {
  switch (state) {
    case 'available':
    case 'reserved':
      return 'available';
    case 'on_call':
    case 'wrapup':
    case 'break':
      return state;
    default:
      return null;
  }
}

/** One day's presence before rounding. */
interface DayAcc {
  seconds: Record<ReportedState, number>;
  breakByReason: Map<string, number>;
  sessions: Set<string>;
  firstIn: number | null;
  lastOut: number | null;
}

/** The time half of a day row, and the break seconds by reason (exact, before rounding). */
export interface DayPresence {
  date: string;
  first_in: string | null;
  last_out: string | null;
  sessions: number;
  available_s: number;
  on_call_s: number;
  wrapup_s: number;
  break_s: number;
  station_s: number;
}

export interface FoldedPresence {
  days: DayPresence[];
  by_state: ReportStateSeconds;
  /** Whole seconds by break reason code (`unspecified` for none), summing to `by_state.break`. */
  break_by_reason: Map<string, number>;
}

/** Fold the intervals into the local days. Intervals outside every day are ignored. */
export function foldPresence(intervals: readonly PresenceInterval[], days: readonly LocalDay[]): FoldedPresence {
  const accs: DayAcc[] = days.map(() => ({
    seconds: { available: 0, on_call: 0, wrapup: 0, break: 0 },
    breakByReason: new Map(),
    sessions: new Set(),
    firstIn: null,
    lastOut: null,
  }));
  for (const iv of intervals) {
    const state = reportedState(iv.state);
    if (state === null) continue;
    const s = iv.started.getTime();
    const e = iv.ended.getTime();
    if (!(e > s)) continue;
    days.forEach((day, i) => {
      const from = Math.max(s, day.start.getTime());
      const to = Math.min(e, day.end.getTime());
      if (!(to > from)) return;
      const acc = accs[i]!;
      const secs = (to - from) / 1000;
      acc.seconds[state] += secs;
      if (state === 'break') {
        const reason = iv.break_reason ?? 'unspecified';
        acc.breakByReason.set(reason, (acc.breakByReason.get(reason) ?? 0) + secs);
      }
      acc.sessions.add(iv.session_id);
      acc.firstIn = acc.firstIn === null ? from : Math.min(acc.firstIn, from);
      acc.lastOut = acc.lastOut === null ? to : Math.max(acc.lastOut, to);
    });
  }

  const states: ReportedState[] = ['available', 'on_call', 'wrapup', 'break'];
  const rounded = Object.fromEntries(states.map((st) => [st, roundPreservingSum(accs.map((a) => a.seconds[st]))])) as Record<ReportedState, number[]>;
  const out: DayPresence[] = days.map((day, i) => {
    const acc = accs[i]!;
    const available_s = rounded.available[i]!;
    const on_call_s = rounded.on_call[i]!;
    const wrapup_s = rounded.wrapup[i]!;
    const break_s = rounded.break[i]!;
    return {
      date: day.date,
      first_in: acc.firstIn === null ? null : new Date(acc.firstIn).toISOString(),
      last_out: acc.lastOut === null ? null : new Date(acc.lastOut).toISOString(),
      sessions: acc.sessions.size,
      available_s, on_call_s, wrapup_s, break_s,
      station_s: available_s + on_call_s + wrapup_s + break_s,
    };
  });
  const by_state: ReportStateSeconds = {
    available: out.reduce((s, d) => s + d.available_s, 0),
    on_call: out.reduce((s, d) => s + d.on_call_s, 0),
    wrapup: out.reduce((s, d) => s + d.wrapup_s, 0),
    break: out.reduce((s, d) => s + d.break_s, 0),
  };

  const reasonTotals = new Map<string, number>();
  for (const acc of accs) for (const [r, v] of acc.breakByReason) reasonTotals.set(r, (reasonTotals.get(r) ?? 0) + v);
  const reasons = [...reasonTotals.keys()].sort();
  const exact = reasons.map((r) => reasonTotals.get(r)!);
  // Rounded to sum to the day-rounded break total (which may differ from the exact sum's
  // rounding by the days' own rounding): scale the remainder onto the largest parts.
  const parts = roundPreservingSum(exact);
  let diff = by_state.break - parts.reduce((s, v) => s + v, 0);
  const order = parts.map((v, i) => i).sort((a, b) => parts[b]! - parts[a]! || a - b);
  for (let k = 0; diff !== 0 && order.length > 0; k = (k + 1) % order.length) {
    const i = order[k]!;
    if (diff > 0) { parts[i]! += 1; diff -= 1; } else if (parts[i]! > 0) { parts[i]! -= 1; diff += 1; }
  }
  return { days: out, by_state, break_by_reason: new Map(reasons.map((r, i) => [r, parts[i]!])) };
}

/** The attempt half of a day row. */
export interface DayAttempts {
  date: string;
  attempts: number;
  first_dials: number;
  connected: number;
  human_connects: number;
  successes: number;
  talk_seconds: number;
  drops: number;
}

/**
 * The day rows: presence and attempts joined on the date, every day present. `talk_s` is rounded
 * across the days to sum to the window's rounded talk time; `conversations` is the record's
 * `connected` (both count `CONVERSATION_ATTEMPT_SQL`).
 */
export function dailyRows(presence: readonly DayPresence[], attempts: readonly DayAttempts[]): AgentReviewDailyRow[] {
  const byDate = new Map(attempts.map((a) => [a.date, a]));
  const talk = roundPreservingSum(presence.map((p) => byDate.get(p.date)?.talk_seconds ?? 0));
  return presence.map((p, i) => {
    const a = byDate.get(p.date);
    return {
      date: p.date,
      first_in: p.first_in,
      last_out: p.last_out,
      sessions: p.sessions,
      drops: a?.drops ?? 0,
      station_s: p.station_s,
      on_call_s: p.on_call_s,
      wrapup_s: p.wrapup_s,
      available_s: p.available_s,
      break_s: p.break_s,
      dials: a?.attempts ?? 0,
      first_dials: a?.first_dials ?? 0,
      connected: a?.connected ?? 0,
      conversations: a?.connected ?? 0,
      human_connects: a?.human_connects ?? 0,
      successes: a?.successes ?? 0,
      talk_s: talk[i]!,
    };
  });
}

/** The timeline day: the most logged-in seconds, the latest on a tie; null when none. */
export function timelineDay(daily: ReadonlyArray<{ date: string; station_s: number }>): string | null {
  let best: { date: string; station_s: number } | null = null;
  for (const d of daily) {
    if (d.station_s <= 0) continue;
    if (best === null || d.station_s > best.station_s || (d.station_s === best.station_s && d.date > best.date)) best = d;
  }
  return best?.date ?? null;
}

/** The segments of `day`, from its start to `min(day.end, clipEnd)`. */
export function timelineSegments(intervals: readonly PresenceInterval[], day: LocalDay, clipEnd: Date): AgentReviewTimelineSegment[] {
  const start = day.start.getTime();
  const end = Math.min(day.end.getTime(), clipEnd.getTime());
  if (!(end > start)) return [];
  const pieces = intervals
    .map((iv) => ({ state: reportedState(iv.state), reason: iv.break_reason, s: Math.max(iv.started.getTime(), start), e: Math.min(iv.ended.getTime(), end) }))
    .filter((p): p is { state: ReportedState; reason: string | null; s: number; e: number } => p.state !== null && p.e > p.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const out: Array<{ s: number; e: number; state: ReportTimelineState; reason: string | null }> = [];
  const push = (s: number, e: number, state: ReportTimelineState, reason: string | null) => {
    if (!(e > s)) return;
    const last = out[out.length - 1];
    if (last && last.state === state && last.reason === reason && last.e === s) last.e = e;
    else out.push({ s, e, state, reason });
  };
  let cursor = start;
  for (const p of pieces) {
    const s = Math.max(p.s, cursor);
    if (!(p.e > s)) continue;
    push(cursor, s, 'offline', null);
    push(s, p.e, p.state, p.state === 'break' ? (p.reason ?? 'unspecified') : null);
    cursor = p.e;
  }
  push(cursor, end, 'offline', null);
  return out.map((x) => ({ start: new Date(x.s).toISOString(), end: new Date(x.e).toISOString(), state: x.state, break_reason: x.reason }));
}

/** The timeline block: the chosen day and its strip, or null when the agent was never logged in. */
export function buildTimeline(
  intervals: readonly PresenceInterval[],
  days: readonly LocalDay[],
  daily: ReadonlyArray<{ date: string; station_s: number }>,
  clipEnd: Date,
): AgentReviewTimeline | null {
  const date = timelineDay(daily);
  const day = date === null ? undefined : days.find((d) => d.date === date);
  if (!day) return null;
  return { date: day.date, segments: timelineSegments(intervals, day, clipEnd) };
}
