/**
 * Rates and derived figures the PDF and the workbook both print, derived once so the two files
 * cannot disagree.
 */
import {
  agencyCallsByType,
  type AccountReportFigures,
  type AgencyCallsByTypeTable,
  type AgentReviewDataset,
  type CampaignReportDataset,
} from '@magick-agency/contracts/reports';
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

/**
 * The soft-phone calls logged to the campaign and the Outbound total beside the dialler's
 * figures (SR1–SR3, SR8, CL7); `null` when the report shows none. Shown when the window holds any
 * placed soft-phone call (the console's rule for a soft phone switched off, SR5: a report has no
 * flag to read) and never when the dataset predates them. The PDF and the workbook both gate on
 * this, so the two files show the same rows.
 */
export interface CampaignSoftphoneFigures {
  placed: number;
  connected: number;
  humanConnects: number;
  /** Talk time of the placed calls; null from a dataset that predates it (printed as a dash, added to nothing). */
  talkSeconds: number | null;
  /** People reached ÷ placed: every soft-phone call is a first dial (SR2). */
  connect: Rate;
  /**
   * The dialler's counts and the soft phone's added (SR3): every call we placed. Its rate is the
   * **Outbound connect rate** (CL7; "All calls connect rate" before inbound calls joined the
   * report). An inbound call is never in it.
   */
  outbound: {
    /** Dials (wrap-up redials included) + soft-phone calls placed. */
    placed: number;
    connected: number;
    humanConnects: number;
    /** The rate's denominator: the dialler's first dials + soft-phone calls placed. */
    firstCalls: number;
    /** (People reached + soft-phone people reached) ÷ first calls, under the one floor on its own denominator. */
    connect: Rate;
  };
}

export function campaignSoftphoneFigures(d: CampaignReportDataset): CampaignSoftphoneFigures | null {
  const calls = d.activity.calls;
  const soft = calls.softphone;
  if (!soft || soft.placed <= 0) return null;
  const floor = d.floors.campaign_rate_min_first_dials;
  const firstCalls = calls.dials - calls.redials.placed + soft.placed;
  const humanConnects = calls.human_connects + soft.human_connects;
  return {
    placed: soft.placed,
    connected: soft.connected,
    humanConnects: soft.human_connects,
    talkSeconds: typeof soft.talk_seconds === 'number' ? soft.talk_seconds : null,
    connect: rate(soft.human_connects, soft.placed, floor),
    outbound: {
      placed: calls.dials + soft.placed,
      connected: calls.connected + soft.connected,
      humanConnects,
      firstCalls,
      connect: rate(humanConnects, firstCalls, floor),
    },
  };
}

/**
 * The inbound calls filed under the campaign (`docs/call-log.md` §6); `null` when the report
 * shows none. Shown when the window holds an inbound call (the soft phone's gate, SR8: a report
 * has no flag to read), or when the campaign has missed calls still to follow up: a week with no
 * inbound call must not hide the callers still owed a call back. Never when the dataset predates
 * them.
 */
export interface CampaignInboundFigures {
  received: number;
  answered: number;
  missed: number;
  /** The campaign's missed calls still open when the report was made, whatever the window. */
  openFollowUps: number;
  talkSeconds: number;
  openHours: number;
  /** Answered ÷ calls that arrived in open hours, under the one floor on its own denominator. */
  answer: Rate;
}

export function campaignInboundFigures(d: CampaignReportDataset): CampaignInboundFigures | null {
  const inbound = d.activity.calls.inbound;
  if (!inbound || (inbound.received <= 0 && inbound.open_follow_ups <= 0)) return null;
  return {
    received: inbound.received,
    answered: inbound.answered,
    missed: inbound.missed,
    openFollowUps: inbound.open_follow_ups,
    talkSeconds: inbound.talk_seconds,
    openHours: inbound.open_hours,
    answer: rate(inbound.answered, inbound.open_hours, d.floors.campaign_rate_min_first_dials),
  };
}

/**
 * The campaign's calls by type (`docs/call-log.md` §6): one column per type the report shows,
 * and All calls, the counts added (the contract's table, `agencyCallsByType`, shared with the
 * console's Insights, with this report's rates). `null` when only the dialler has calls to
 * show: the report then prints the figures it always did. Counts, people reached and talk time
 * add up; **no rate is added** (CL7): each type's rate measures a different thing. One gate for
 * the PDF and the workbook.
 */
export interface CampaignCallsByType extends AgencyCallsByTypeTable<Rate> {
  soft: CampaignSoftphoneFigures | null;
  inbound: CampaignInboundFigures | null;
}

export function campaignCallsByType(d: CampaignReportDataset): CampaignCallsByType | null {
  const soft = campaignSoftphoneFigures(d);
  const inbound = campaignInboundFigures(d);
  if (!soft && !inbound) return null;
  const calls = d.activity.calls;
  const table = agencyCallsByType<Rate>({
    dialler: {
      calls: calls.dials,
      connected: calls.connected,
      reached: calls.human_connects,
      talk_seconds: calls.talk_seconds,
      rate: campaignFigures(d).connect,
    },
    soft_phone: soft && {
      calls: soft.placed,
      connected: soft.connected,
      reached: soft.humanConnects,
      talk_seconds: soft.talkSeconds,
      rate: soft.connect,
    },
    inbound: inbound && {
      calls: inbound.received,
      connected: inbound.answered,
      // A caller an agent answered is a person reached: nobody rings us by machine.
      reached: inbound.answered,
      talk_seconds: inbound.talkSeconds,
      missed: inbound.missed,
      open_follow_ups: inbound.openFollowUps,
      rate: inbound.answer,
    },
  });
  return { ...table, soft, inbound };
}

/** One outcome of the campaign on each call type; a type the report does not show counts 0. */
export interface CampaignOutcomeRow {
  code: string | null;
  label: string | null;
  is_success: boolean;
  dialler: number;
  soft_phone: number;
  inbound: number;
  /** The three added: what the rows are sorted by, and the Total column. */
  total: number;
}

/**
 * The Outcomes table's rows. Without the by-type columns (`typed` null) they are the dialler's
 * conversations by code, as the report always printed them. With them, every outcome any shown
 * type holds (`outcomes_by_type`, CL28), a type the report does not show left at 0 so the Total
 * is the sum of the columns printed.
 */
export function campaignOutcomeRows(d: CampaignReportDataset, typed: CampaignCallsByType | null): CampaignOutcomeRow[] {
  const byType = d.activity.outcomes_by_type;
  if (!typed || !byType) {
    return d.activity.outcomes.map((o) => ({
      code: o.code, label: o.label, is_success: o.is_success, dialler: o.count, soft_phone: 0, inbound: 0, total: o.count,
    }));
  }
  const shown = new Set(typed.columns.map((c) => c.type));
  return byType
    .map((o) => {
      const softPhone = shown.has('soft_phone') ? o.soft_phone : 0;
      const inbound = shown.has('inbound') ? o.inbound : 0;
      return {
        code: o.code, label: o.label, is_success: o.is_success,
        dialler: o.dialler, soft_phone: softPhone, inbound, total: o.dialler + softPhone + inbound,
      };
    })
    .filter((o) => o.total > 0)
    .sort((a, b) => b.total - a.total);
}

/** One campaign row's or the account totals' figures, rates recomputed from the counts. */
export function accountFigures(f: AccountReportFigures, floor: number): CallFigures {
  return callFigures(f.calls, f.answered, f.abandoned, floor);
}

/** Recorded ÷ connected calls: no sample floor, words only when nothing connected. */
export function recordingShare(recorded: number, connected: number): Rate {
  return rate(recorded, connected, 1);
}
