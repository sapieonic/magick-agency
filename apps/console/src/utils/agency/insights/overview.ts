import { ATTEMPT_OUTCOME_LABELS } from '@magick-agency/contracts/api/agency/agency-spine';
import type { AgencyAttemptOutcome } from '../../../types/agency';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsHealth,
  AgencyInsightsSummary,
} from '../../../types/agency-insights';
import type { CampaignTabId } from '../../agencyCampaignTabs';
import { formatCount, plural } from '../../format/number';
import { durationWords } from '../../format/duration';
import { describeIsoDays, hhmm } from '../../format/weekdays';
import { abandonmentTone, ceilingPctText } from '../abandonmentCeiling';
import { abandonmentRate, insightsRate, rateText } from './rates';
import { IDLE_REASON_LABELS } from './copy';

/**
 * The Overview tab's words and rules (decision IN13): the "Needs your attention"
 * list — the few things on the campaign a supervisor should act on, most urgent
 * first, each with the tab that answers it — and the cards that open the other
 * tabs. Pure, so every rule is tested where it is made.
 *
 * ── What it reads ───────────────────────────────────────────────────────────
 * Only as-of-now positions and the health read's own "now" figures: overdue
 * callbacks and staffing from the allocation (polled), and abandonment over the
 * guardrail's rolling 24 hours. Range totals (dials,
 * successes) are never a reason to act, so the range picker cannot make an item
 * appear or vanish — except the carrier failures and missing recordings, which
 * are counted over the range and say so.
 *
 * ── What it leaves to others ────────────────────────────────────────────────
 * The campaign's status (paused, stopping, the launch checklist) is the
 * headline's, and a blocker that stops dialling now — a stall, by any reason —
 * is the health strip's above the tabs, read as of now on every tab. Neither is
 * repeated here: the health read's stall episodes cover the range, so a stall
 * going on now is missing from them whenever the range ends in the past.
 */

export type AttentionTone = 'danger' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  body: string;
  /** The tab that answers it. */
  tab: CampaignTabId;
  /** The button's words. */
  action: string;
}

export interface AttentionInput {
  summary: AgencyInsightsSummary;
  /** Null until the allocation read answers. */
  allocation: AgencyInsightsAllocation | null;
  /** Null until the health read answers. */
  health: AgencyInsightsHealth | null;
}

export interface Attention {
  items: AttentionItem[];
  /** The checks that passed, as short phrases ("abandonment 0.4% (ceiling 3%)"). Empty until health answers. */
  clear: string[];
}

const TONE_ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };

/** The agents assigned to the campaign, and how many of them are on the floor now. */
function staffing(allocation: AgencyInsightsAllocation): { staffed: number; online: number } {
  const staffed = allocation.agents.filter((a) => a.staffed);
  return { staffed: staffed.length, online: staffed.filter((a) => a.state !== 'offline').length };
}

/** A campaign that can still dial, now or after a resume. */
function canDial(status: string): boolean {
  return status === 'running' || status === 'paused';
}

export function campaignAttention({ summary, allocation, health }: AttentionInput): Attention {
  const items: AttentionItem[] = [];
  const clear: string[] = [];
  const live = canDial(summary.status);

  // ── Callbacks promised and not kept ─────────────────────────────────────
  if (allocation && allocation.totals.callbacks_overdue > 0) {
    const overdue = allocation.totals.callbacks_overdue;
    const unowned = allocation.unassigned.callbacks_overdue;
    const absent = allocation.at_risk.overdue_callbacks_absent_owner;
    const parts: string[] = [];
    if (unowned === overdue) parts.push(overdue === 1 ? 'It has no owner.' : 'None of them has an owner.');
    else if (unowned > 0) parts.push(`${formatCount(unowned)} ${unowned === 1 ? 'has' : 'have'} no owner.`);
    if (absent > 0) parts.push(`${formatCount(absent)} ${absent === 1 ? 'belongs' : 'belong'} to an agent who is away.`);
    parts.push('Customers were promised these calls.');
    items.push({
      id: 'callbacks-overdue',
      tone: 'danger',
      title: `${plural(overdue, 'callback')} overdue`,
      body: parts.join(' '),
      tab: 'callbacks',
      action: 'Callbacks',
    });
  }

  // ── Abandonment against the guardrail ───────────────────────────────────
  if (health) {
    const rate = abandonmentRate(health.abandonment.rolling_24h);
    const ceiling = health.abandonment.ceiling_pct;
    const tone = rate.kind === 'value' ? abandonmentTone(rate.pct, ceiling) : undefined;
    if (rate.kind === 'value' && tone) {
      items.push({
        id: 'abandonment',
        tone: tone === 'bad' ? 'danger' : 'warning',
        title: tone === 'bad'
          ? `Abandonment ${rateText(rate)} is over the ${ceilingPctText(ceiling)} ceiling`
          : `Abandonment ${rateText(rate)} is close to the ${ceilingPctText(ceiling)} ceiling`,
        body: 'Over the last 24 hours. Above the ceiling the guardrail pauses the campaign.',
        tab: 'health',
        action: 'Health',
      });
    } else if (rate.kind === 'value') {
      clear.push(`abandonment ${rateText(rate)} (ceiling ${ceilingPctText(ceiling)})`);
    }
    // Too few answered calls to measure is neither a pass nor a problem: say nothing.
  }

  // ── Nobody on the floor ─────────────────────────────────────────────────
  if (allocation && live) {
    const { staffed, online } = staffing(allocation);
    // Only while it runs: a paused campaign dials nothing until it is resumed,
    // agents or none, so an empty floor at the end of a shift is not a problem.
    if (online === 0 && summary.status === 'running') {
      items.push({
        id: 'no-agents',
        tone: 'warning',
        title: 'No agents online',
        body: staffed === 0
          ? 'Nobody is assigned to this campaign yet.'
          : staffed === 1
            ? 'The one assigned agent is not on the floor. Nothing dials until they join.'
            : `None of the ${formatCount(staffed)} assigned agents is on the floor. Nothing dials until one joins.`,
        tab: 'agents',
        action: 'Agents',
      });
    }
    const held = allocation.at_risk.held_by_absent.reduce((n, row) => n + row.due, 0);
    if (held > 0) {
      items.push({
        id: 'held-by-absent',
        tone: 'warning',
        title: `${plural(held, 'due contact')} held by agents who are away`,
        body: `Away longer than ${formatCount(allocation.absent_after_minutes)} minutes, or no longer assigned.`,
        tab: 'agents',
        action: 'Agents',
      });
    }
  }

  // ── Counted over the range ─────────────────────────────────────────────
  if (health) {
    if (health.carrier_failures > 0) {
      items.push({
        id: 'carrier-failures',
        tone: 'info',
        title: `${plural(health.carrier_failures, 'dial')} failed at the carrier`,
        body: 'In the range shown. The error codes are on the Health tab.',
        tab: 'health',
        action: 'Health',
      });
    } else {
      clear.push('no carrier failures');
    }
    const { connected, recorded } = health.recording;
    if (summary.settings.record_calls && recorded < connected) {
      // A recording lands on its call some minutes after the call ends, and only
      // then is the call counted as recorded. While the campaign runs, the
      // last few calls are always short, so the gap is a note, not a warning.
      const running = summary.status === 'running';
      items.push({
        id: 'recordings-missing',
        tone: running ? 'info' : 'warning',
        title: `${plural(connected - recorded, 'connected call')} with no recording`,
        body: `Recording is on, and ${formatCount(recorded)} of ${formatCount(connected)} connected calls in the range have one.${running ? ' The latest calls can take a few minutes to show theirs.' : ''}`,
        tab: 'health',
        action: 'Health',
      });
    } else if (summary.settings.record_calls && connected > 0) {
      clear.push('every connected call recorded');
    }
  }

  // ── Calling hours never set ─────────────────────────────────────────────
  // The launch checklist warns on a draft (IN7); this keeps saying so after launch.
  if (summary.settings.calling_hours_default && (live || summary.status === 'draft')) {
    const s = summary.settings;
    items.push({
      id: 'calling-hours-default',
      tone: 'info',
      title: 'Calling hours are still the default',
      body: `${hhmm(s.calling_window_start)}–${hhmm(s.calling_window_end)}, ${describeIsoDays(s.calling_days) ?? 'no days'}, in each contact’s own time zone.`,
      tab: 'settings',
      action: 'Settings',
    });
  }

  // Stable within a tone: the order the rules run in.
  items.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  return { items, clear };
}

// ── The cards that open the other tabs ────────────────────────────────────

/** Two lines that say what is on a tab before it is opened. */
export interface TabTeaser {
  line1: string;
  line2: string | null;
}

/** Calls: the commonest way a dial ended, and the commonest disposition. */
export function callsTeaser(activity: AgencyInsightsActivity): TabTeaser {
  const { calls } = activity;
  if (calls.dials === 0) return { line1: 'No dials in this range.', line2: null };
  const outcomes = (Object.keys(ATTEMPT_OUTCOME_LABELS) as AgencyAttemptOutcome[])
    .map((outcome) => ({ outcome, count: calls.by_outcome[outcome] ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const top = outcomes[0];
  const share = top ? insightsRate(top.count, calls.dials) : null;
  // Below the rate floor the share is withheld (IN5), so the line gives the count instead.
  const line1 = !top || top.count === 0
    ? `${plural(calls.dials, 'dial')}, none recorded yet.`
    : share?.kind === 'value'
      ? `${ATTEMPT_OUTCOME_LABELS[top.outcome]} on ${rateText(share)} of ${plural(calls.dials, 'dial')}.`
      : `${ATTEMPT_OUTCOME_LABELS[top.outcome]} on ${formatCount(top.count)} of ${plural(calls.dials, 'dial')}.`;
  const disposition = activity.outcomes
    .filter((row) => row.code !== null && row.count > 0)
    .sort((a, b) => b.count - a.count)[0];
  const line2 = disposition
    ? `Top disposition: ${disposition.label ?? disposition.code}, ${formatCount(disposition.count)} of ${plural(calls.conversations, 'conversation')}.`
    : 'No conversations written up yet.';
  return { line1, line2 };
}

/** Agents: who is on the floor now, and who carried the range. */
export function agentsTeaser(activity: AgencyInsightsActivity | null, allocation: AgencyInsightsAllocation | null): TabTeaser {
  let line1 = 'Who is on the floor, and how each agent is doing.';
  if (allocation) {
    const { staffed, online } = staffing(allocation);
    line1 = staffed === 0 ? 'Nobody is assigned yet.' : `${formatCount(online)} of ${plural(staffed, 'assigned agent')} online now.`;
  }
  const rows = (activity?.agents ?? []).filter((row) => row.agent_user_id !== null && row.dials > 0);
  if (rows.length === 0) return { line1, line2: activity ? 'No agent dials in this range.' : null };
  const busiest = rows.slice().sort((a, b) => b.dials - a.dials)[0]!;
  const withSuccess = rows.filter((row) => row.successes > 0).length;
  const name = busiest.agent_name ?? 'An agent';
  return {
    line1,
    line2: `${name} made the most dials (${formatCount(busiest.dials)}); ${withSuccess === 0 ? 'no agent has a success yet' : `${plural(withSuccess, 'agent')} with a success`}.`,
  };
}

/** Health: the guardrail's rate, and how long the dialler sat idle and why. */
export function healthTeaser(health: AgencyInsightsHealth): TabTeaser {
  const rate = abandonmentRate(health.abandonment.rolling_24h);
  const line1 = rate.kind === 'value'
    ? `Abandonment ${rateText(rate)} over 24 hours, ceiling ${ceilingPctText(health.abandonment.ceiling_pct)}.`
    : `Abandonment ceiling ${ceilingPctText(health.abandonment.ceiling_pct)}; too few answered calls to measure.`;
  const reasons = Object.entries(health.stalls.minutes_by_reason) as Array<[keyof typeof IDLE_REASON_LABELS, number]>;
  const idle = reasons.reduce((n, [, m]) => n + m, 0);
  if (idle === 0) return { line1, line2: 'No stalls in this range.' };
  const top = reasons.slice().sort((a, b) => b[1] - a[1])[0]!;
  return { line1, line2: `Idle ${durationWords(idle * 60)} in this range, mostly ${IDLE_REASON_LABELS[top[0]].toLowerCase()}.` };
}
