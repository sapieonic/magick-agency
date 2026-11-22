/**
 * Rates and derived figures the PDF and the workbook both print, derived once so the two files
 * cannot disagree.
 */
import {
  AGENCY_CALL_LOG_TYPE_LABELS,
  AGENCY_CALLS_BY_TYPE_RATE_LABELS,
  agencyCallsByTypeFootnote,
  type AccountReportFigures,
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
  /** Talk time of the placed calls; 0 from a dataset that predates it. */
  talkSeconds: number;
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
    talkSeconds: soft.talk_seconds ?? 0,
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
 * has no flag to read) and never when the dataset predates them.
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
  if (!inbound || inbound.received <= 0) return null;
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

/** One call type's column of the Calls by type table. */
export interface CallsByTypeColumn {
  key: 'dialler' | 'soft_phone' | 'inbound';
  /** "Dialler", "Soft phone", "Inbound": the Call log's words. */
  label: string;
  calls: number;
  /** What a call of the type is: "dialled" or "received". */
  callsWord: 'dialled' | 'received';
  connected: number;
  reached: number;
  talkSeconds: number;
  /** Only inbound has calls we missed. */
  missed: number | null;
  openFollowUps: number | null;
  rate: Rate;
  rateLabel: string;
}

/**
 * The campaign's calls by type (`docs/call-log.md` §6): one column per type the report shows,
 * and All calls, the counts added. `null` when only the dialler has calls to show: the report
 * is then exactly what it was. Counts, people reached and talk time add up; **no rate is added**
 * (CL7): each type's rate measures a different thing. One gate for the PDF and the workbook.
 */
export interface CampaignCallsByType {
  columns: CallsByTypeColumn[];
  all: { calls: number; connected: number; reached: number; talkSeconds: number; missed: number | null };
  soft: CampaignSoftphoneFigures | null;
  inbound: CampaignInboundFigures | null;
}

export function campaignCallsByType(d: CampaignReportDataset): CampaignCallsByType | null {
  const soft = campaignSoftphoneFigures(d);
  const inbound = campaignInboundFigures(d);
  if (!soft && !inbound) return null;
  const calls = d.activity.calls;
  const columns: CallsByTypeColumn[] = [
    {
      key: 'dialler',
      label: AGENCY_CALL_LOG_TYPE_LABELS.dialler,
      calls: calls.dials,
      callsWord: 'dialled',
      connected: calls.connected,
      reached: calls.human_connects,
      talkSeconds: calls.talk_seconds,
      missed: null,
      openFollowUps: null,
      rate: campaignFigures(d).connect,
      rateLabel: AGENCY_CALLS_BY_TYPE_RATE_LABELS.dialler,
    },
  ];
  if (soft) {
    columns.push({
      key: 'soft_phone',
      label: AGENCY_CALL_LOG_TYPE_LABELS.soft_phone,
      calls: soft.placed,
      callsWord: 'dialled',
      connected: soft.connected,
      reached: soft.humanConnects,
      talkSeconds: soft.talkSeconds,
      missed: null,
      openFollowUps: null,
      rate: soft.connect,
      rateLabel: AGENCY_CALLS_BY_TYPE_RATE_LABELS.soft_phone,
    });
  }
  if (inbound) {
    columns.push({
      key: 'inbound',
      label: AGENCY_CALL_LOG_TYPE_LABELS.inbound,
      calls: inbound.received,
      callsWord: 'received',
      connected: inbound.answered,
      // A caller an agent answered is a person reached: nobody rings us by machine.
      reached: inbound.answered,
      talkSeconds: inbound.talkSeconds,
      missed: inbound.missed,
      openFollowUps: inbound.openFollowUps,
      rate: inbound.answer,
      rateLabel: AGENCY_CALLS_BY_TYPE_RATE_LABELS.inbound,
    });
  }
  const sum = (pick: (c: CallsByTypeColumn) => number) => columns.reduce((s, c) => s + pick(c), 0);
  return {
    columns,
    all: {
      calls: sum((c) => c.calls),
      connected: sum((c) => c.connected),
      reached: sum((c) => c.reached),
      talkSeconds: sum((c) => c.talkSeconds),
      missed: inbound ? inbound.missed : null,
    },
    soft,
    inbound,
  };
}

/** The footnote under the Calls by type table, for the types it shows. */
export function callsByTypeFootnote(t: CampaignCallsByType): string {
  return agencyCallsByTypeFootnote(t.columns.map((c) => c.key));
}

/** One outcome of the campaign on each call type; a type the report does not show counts 0. */
export interface CampaignOutcomeRow {
  code: string | null;
  label: string | null;
  is_success: boolean;
  dialler: number;
  soft_phone: number;
  inbound: number;
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
    return d.activity.outcomes.map((o) => ({ code: o.code, label: o.label, is_success: o.is_success, dialler: o.count, soft_phone: 0, inbound: 0 }));
  }
  const shown = new Set(typed.columns.map((c) => c.key));
  return byType
    .map((o) => ({
      code: o.code,
      label: o.label,
      is_success: o.is_success,
      dialler: o.dialler,
      soft_phone: shown.has('soft_phone') ? o.soft_phone : 0,
      inbound: shown.has('inbound') ? o.inbound : 0,
    }))
    .filter((o) => o.dialler + o.soft_phone + o.inbound > 0)
    .sort((a, b) => (b.dialler + b.soft_phone + b.inbound) - (a.dialler + a.soft_phone + a.inbound));
}

/** One campaign row's or the account totals' figures, rates recomputed from the counts. */
export function accountFigures(f: AccountReportFigures, floor: number): CallFigures {
  return callFigures(f.calls, f.answered, f.abandoned, floor);
}

/** Recorded ÷ connected calls: no sample floor, words only when nothing connected. */
export function recordingShare(recorded: number, connected: number): Rate {
  return rate(recorded, connected, 1);
}
