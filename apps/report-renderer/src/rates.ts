/**
 * Rates and derived figures the PDF and the workbook both print, derived once so the two files
 * cannot disagree.
 */
import type { AccountReportFigures, AgentReviewDataset, CampaignReportDataset } from '@magick-agency/contracts/reports';
import { average, rate, servedRate, type Rate } from './format';

/** A roster row's gates (the agent review's `roster_row`, the account report's `agents[]`). */
type RosterGates = Pick<NonNullable<AgentReviewDataset['roster_row']>, 'rates_reportable' | 'success_rate_reportable'>;

/**
 * Whether the roster row's success rate (and handle time) may be quoted: its own gate on
 * connected calls when served, else the row's first-dials gate.
 */
export function rosterSuccessReportable(row: RosterGates): boolean {
  return row.success_rate_reportable ?? row.rates_reportable;
}

/** The agent's connect rate as the record serves it, quoted only past the roster's floor. */
export function agentConnectRate(d: AgentReviewDataset): Rate {
  const firstDials = d.daily.reduce((s, r) => s + r.first_dials, 0);
  const reportable = d.roster_row ? d.roster_row.rates_reportable : firstDials >= d.floors.agent_rate_min_first_dials;
  return servedRate(d.record.connect_rate_pct, reportable, firstDials);
}

/** The record's success rate (successes ÷ connected), quoted only past the floor on connected calls. */
export function agentSuccessRate(d: AgentReviewDataset): Rate {
  const reportable = d.roster_row ? rosterSuccessReportable(d.roster_row) : d.record.connected >= d.floors.agent_rate_min_first_dials;
  return servedRate(d.record.success_rate_pct, reportable, d.record.connected);
}

/** The figures a campaign's or the account's call counts give, each rate under the Insights floor. */
export interface CallFigures {
  /** Dials that were not wrap-up redials: the connect rate's denominator. */
  firstDials: number;
  answered: number;
  abandoned: number;
  /** People reached ÷ first dials. */
  connect: Rate;
  /** Successes ÷ conversations. */
  success: Rate;
  /** Abandoned ÷ answered. */
  abandonment: Rate;
  /** Average talk per connected call; null with no connected calls. */
  talk: number | null;
  /** Average measured wrap-up; null when none was measured. */
  wrap: number | null;
  /** Average talk plus average measured wrap-up (none counts as 0); null exactly when `talk` is. */
  handle: number | null;
}

function callFigures(calls: AccountReportFigures['calls'], answered: number, abandoned: number, floor: number): CallFigures {
  const firstDials = calls.dials - calls.redials.placed;
  const talk = average(calls.talk_seconds, calls.connected);
  const wrap = average(calls.wrapup_seconds, calls.wrapup_measured);
  return {
    firstDials,
    answered,
    abandoned,
    connect: rate(calls.human_connects, firstDials, floor),
    success: rate(calls.successes, calls.conversations, floor),
    abandonment: rate(abandoned, answered, floor),
    talk,
    wrap,
    handle: talk === null ? null : talk + (wrap ?? 0),
  };
}

/** The campaign report's window figures; answered and abandoned are summed over its trend buckets. */
export function campaignFigures(d: CampaignReportDataset): CallFigures {
  const answered = d.trends.buckets.reduce((s, b) => s + b.answered, 0);
  const abandoned = d.trends.buckets.reduce((s, b) => s + b.abandoned, 0);
  return callFigures(d.activity.calls, answered, abandoned, d.floors.campaign_rate_min_first_dials);
}

/** One campaign row's or the account totals' figures, rates recomputed from the counts. */
export function accountFigures(f: AccountReportFigures, floor: number): CallFigures {
  return callFigures(f.calls, f.answered, f.abandoned, floor);
}

/** Recorded ÷ connected calls: no sample floor, words only when nothing connected. */
export function recordingShare(recorded: number, connected: number): Rate {
  return rate(recorded, connected, 1);
}
