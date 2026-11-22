import type {
  AgencyCallLogInboundRow,
  AgencyInboundCallLogDetail,
  AgencyInboundJourneyStep,
} from '../../types/agency-call-log';
import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import type { CallFact, CallFactCard } from '../../components/calls/CallDetailView';
import { dispositionLabel, formatCallTimestamp, formatTalkTime } from '../agencySpineCopy';
import { dateFormatter, upperDayPeriod } from '../format/date';
import { formatPromise } from '../format/promise';
import { formatDialNumber } from '../softphone/phoneInput';
import { missedReasonLabel } from '../inbound/missedCopy';
import { callLogWhatHappened, followUpCopy, isMissedInbound, pairedTime } from './callLog';

/**
 * The inbound Call page's words (`docs/call-log.md` §4): one inbound call of a campaign, with
 * the caller's path through it. Pure: no React, no fetch.
 */

/** "3:42:01 PM": a step of the path is told to the second. */
const CLOCK_SECONDS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const clock = (iso: string) => upperDayPeriod(dateFormatter(CLOCK_SECONDS).format(new Date(iso)));

/** Why the call is in this campaign's log, said under the page's title. */
const FILED_UNDER: Record<AgencyCallLogInboundRow['campaign_source'], string> = {
  contact: 'filed under this campaign because the number is on its list',
  route: 'filed under this campaign because the number they rang sends unknown callers here',
  agent: 'filed under this campaign by the agent who took the call',
  supervisor: 'filed under this campaign by a supervisor',
};

/** The line under the title: "Inbound · 22 Nov 2026, 3:42 PM · filed under this campaign because …". */
export function inboundCallHeadline(row: AgencyCallLogInboundRow): string {
  return `Inbound · ${formatCallTimestamp(row.created_at)} · ${FILED_UNDER[row.campaign_source]}`;
}

/** Who rang, as the page's title: the number, or that it was withheld. */
export function inboundCallerTitle(row: Pick<AgencyCallLogInboundRow, 'phone_e164'>): string {
  return row.phone_e164 ? formatDialNumber(row.phone_e164) : 'Number withheld';
}

/** One line of the caller's path: what happened, and the detail beside it. */
export interface JourneyLine {
  kind: AgencyInboundJourneyStep['kind'];
  title: string;
  detail: string | null;
}

/**
 * The caller's path, a line per step: "Rang 3:42:01 PM · Sales line", "Greeting", "Waited 0:18 ·
 * offered to their agent first", "Priya Nair answered · 3:42:19 PM", "Ended 3:46:31 PM · talk 4:12".
 * A missed call says why, in the Missed list's words.
 */
export function inboundJourneyLines(detail: Pick<AgencyInboundCallLogDetail, 'inbound' | 'journey'>): JourneyLine[] {
  const row = detail.inbound;
  return detail.journey.map((step): JourneyLine => {
    switch (step.kind) {
      case 'rang':
        return { kind: step.kind, title: 'Rang', detail: [step.at ? clock(step.at) : null, row.route_name].filter(Boolean).join(' · ') || null };
      case 'greeting':
        return { kind: step.kind, title: 'Greeting', detail: 'we answered and played our message' };
      case 'waited':
        return {
          kind: step.kind,
          title: `Waited ${formatTalkTime(step.seconds)}`,
          detail: row.via_sticky_agent ? 'came through their agent' : null,
        };
      case 'answered':
        return { kind: step.kind, title: `${row.agent_name ?? 'An agent'} answered`, detail: step.at ? clock(step.at) : null };
      case 'missed':
        return { kind: step.kind, title: 'Nobody answered', detail: row.follow_up ? missedReasonLabel(row.follow_up) : null };
      case 'voicemail':
        return { kind: step.kind, title: 'Left a voicemail', detail: step.seconds !== null ? formatTalkTime(step.seconds) : null };
      case 'ended':
        return {
          kind: step.kind,
          title: 'Ended',
          detail: [step.at ? clock(step.at) : null, step.seconds !== null ? `talk ${formatTalkTime(step.seconds)}` : null]
            .filter(Boolean).join(' · ') || null,
        };
      default:
        return { kind: step.kind, title: String(step.kind), detail: null };
    }
  });
}

/** The header's facts: who answered, what happened, the number rung, the wait. */
export function inboundIdentityFacts(row: AgencyCallLogInboundRow): CallFact[] {
  const happened = callLogWhatHappened(row);
  return [
    row.agent_user_id
      ? { label: 'Agent', value: row.agent_name ?? 'Former member', muted: row.agent_name === null }
      : { label: 'Agent', value: 'Nobody answered', muted: true },
    { label: 'What happened', value: happened.detail ? `${happened.text} · ${happened.detail}` : happened.text },
    { label: 'Number they rang', value: row.route_name ? `${formatDialNumber(row.caller_id)} · ${row.route_name}` : formatDialNumber(row.caller_id) },
    { label: 'Talk time', value: formatTalkTime(row.talk_seconds), mono: true },
  ];
}

/** When the outcome was saved and by whom: "22 Nov 2026, 3:47 PM · by Priya Nair". */
function savedLine(row: AgencyCallLogInboundRow, by: string | null): string | null {
  if (!row.dispositioned_at) return null;
  const when = formatCallTimestamp(row.dispositioned_at);
  if (row.dispositioned_on_behalf) return by ? `${when} · by ${by}, on the agent’s behalf` : `${when} · by a supervisor, on the agent’s behalf`;
  return by ? `${when} · by ${by}` : when;
}

/** The outcome the agent saved on an answered call, labelled as the agent's. */
export function inboundOutcomeCard(
  detail: Pick<AgencyInboundCallLogDetail, 'inbound' | 'dispositioned_by_name'>,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): CallFactCard {
  const row = detail.inbound;
  const label = dispositionLabel(row.disposition_code, catalog);
  const facts: CallFact[] = [
    {
      label: 'Outcome',
      value: label ?? (row.requires_disposition ? 'No outcome yet' : 'Not written up'),
      muted: row.disposition_code === null,
      ...(label !== null && label !== row.disposition_code ? { hint: `Filed as “${row.disposition_code}”` } : {}),
    },
    { label: 'Saved', value: savedLine(row, detail.dispositioned_by_name) },
  ];
  if (row.callback_at) facts.push({ label: 'Call back', value: formatCallTimestamp(row.callback_at) });
  if (row.promise_date) {
    facts.push({ label: 'Promise to pay', value: formatPromise({ date: row.promise_date, amount: row.promise_amount ?? null }) });
  }
  facts.push({ label: 'Notes', value: row.notes ?? 'None', muted: row.notes === null, prose: true });
  return { title: 'Outcome', facts, source: 'Agent' };
}

/** Where a missed call's follow-up stands: why it was missed, who has it, whether it was rung back. */
export function inboundFollowUpCard(row: AgencyCallLogInboundRow): CallFactCard | null {
  const followUp = row.follow_up;
  if (!followUp) return null;
  const copy = followUpCopy(row);
  const facts: CallFact[] = [
    { label: 'Follow-up', value: followUp.status === 'open' ? 'To follow up' : followUp.handled_reason === 'reached' ? 'Customer reached' : 'Handled' },
    { label: 'Why it was missed', value: missedReasonLabel(followUp) },
    {
      label: 'Assigned to',
      value: followUp.assignee_user_id ? followUp.assignee_name ?? 'Former member' : 'The account',
      muted: !followUp.assignee_user_id,
    },
  ];
  if (row.called_back) {
    facts.push({ label: 'Called back', value: pairedTime(row.called_back.at, row.created_at), hint: 'A soft-phone call placed from this call’s Call back.' });
  } else if (copy.open) {
    facts.push({ label: 'Called back', value: 'Not yet', muted: true });
  }
  if (followUp.handled_at) facts.push({ label: 'Closed', value: formatCallTimestamp(followUp.handled_at) });
  return { title: 'Follow-up', facts };
}

/** The cards under the header: the follow-up of a missed call, or the outcome of an answered one. */
export function inboundCallCards(
  detail: Pick<AgencyInboundCallLogDetail, 'inbound' | 'dispositioned_by_name'>,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): CallFactCard[] {
  const followUp = inboundFollowUpCard(detail.inbound);
  return isMissedInbound(detail.inbound) ? (followUp ? [followUp] : []) : [inboundOutcomeCard(detail, catalog)];
}

/** The call's own record, for a page with no media leg to draw the header from. */
export function inboundRecordCard(row: AgencyCallLogInboundRow): CallFactCard {
  return {
    title: 'Call record',
    facts: [
      { label: 'Caller', value: inboundCallerTitle(row), mono: row.phone_e164 !== null, muted: row.phone_e164 === null },
      { label: 'When', value: formatCallTimestamp(row.created_at) },
      ...inboundIdentityFacts(row),
    ],
  };
}
