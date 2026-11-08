/**
 * The definitions page and the standard notes of each report kind: what every printed figure
 * means, in British English, final copy (the renderer prints it as is). Each text states the
 * numerator, the denominator and the floor where the figure has them, as the source read
 * computes it (docs/reports.md "Datasets"). RP9: agent rows and bands use the roster's floor
 * (20 first dials), campaign and account figures Insights' (25); both are named.
 */
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '@magick-agency/contracts/agency';
import { AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR, AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import type { ReportDefinition } from '@magick-agency/contracts/reports';

const d = (key: string, label: string, text: string): ReportDefinition => ({ key, label, text });

const ROSTER_FLOOR = AGENCY_ROSTER_MIN_RATE_DENOMINATOR;
const INSIGHTS_FLOOR = AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR;
const ON_TIME = AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES;

/** The callback classes (IN4), shared by the agent review and the campaign report. */
const CALLBACK_DEFINITIONS: ReportDefinition[] = [
  d('callbacks_booked', 'Callbacks booked', 'Calls in the window that ended with a callback time set, counted at the dial that booked them.'),
  d('callbacks_on_time', 'Callbacks kept on time', `Of the callbacks due in the window, those whose follow-up call was dialled no later than ${ON_TIME} minutes after the booked time (an early call counts as on time).`),
  d('callbacks_late', 'Callbacks kept late', `Callbacks due in the window whose follow-up call was dialled more than ${ON_TIME} minutes after the booked time.`),
  d('callbacks_missed', 'Callbacks missed', 'Callbacks due in the window that were never dialled because the contact was closed first or the campaign ended.'),
  d('callbacks_pending', 'Callbacks pending', 'Callbacks due in the window that have not been dialled yet: upcoming while the booked time is still ahead, overdue once it has passed.'),
];

/** The agent review's definitions, in print order. `self` leaves out the comparison and analysis. */
export function agentDefinitions(audience: 'supervisor' | 'self'): ReportDefinition[] {
  const out: ReportDefinition[] = [
    d('dials', 'Dials', 'Every call placed for the agent in the window, wrap-up redials included.'),
    d('first_dials', 'First dials', 'Dials that were not wrap-up redials: the connect rate\'s denominator.'),
    d('connected', 'Connected', 'Calls bridged to the agent, counted once per conversation: a wrap-up redial chain is one conversation, counted at the call that carries its outcome.'),
    d('connect_rate', 'Connect rate', `People reached ÷ first dials. A person is reached when a conversation is closed with an outcome other than voicemail or "no outcome". Shown in words below ${ROSTER_FLOOR} first dials.`),
    d('successes', 'Successes', 'Conversations closed with an outcome the campaign marks as a success, by each campaign\'s current outcome list.'),
    d('success_rate', 'Success rate', `Successes ÷ conversations (connected calls). Shown in words below ${ROSTER_FLOOR} first dials.`),
    d('talk_time', 'Talk time', 'The agent\'s leg of each connected call: from the moment it was bridged to the agent until it ended. Calls the system closed after a fault are left out.'),
    d('wrapup_time', 'Wrap-up time', 'Measured wrap-up: from the end of the call until the agent submitted an outcome, returned early or was returned automatically. Wrap-ups ended by a supervisor, by the agent leaving or by the campaign stopping are left out.'),
    d('aht', 'Average handle time', '(Talk time + wrap-up time) ÷ connected calls.'),
    d('logged_in_time', 'Logged-in time', 'Time in any state but offline, taken from the recorded state changes of the agent\'s sessions in this account, campaign and soft phone. Reserved time (a call being connected) counts as available.'),
    d('occupancy', 'Occupancy (handling)', '(Talk time + wrap-up time) ÷ logged-in time, breaks included. This is the figure compared with the floor.'),
    d('on_call_share', 'On-call share', 'Time in the on-call state ÷ logged-in time, breaks included.'),
    d('on_call_share_excl_break', 'On-call share excluding breaks', 'Time in the on-call state ÷ logged-in time with break time taken out.'),
    d('days_worked', 'Days worked', 'Days with any logged-in time.'),
    d('first_in_last_out', 'First in, last out', 'The first and last logged-in moment of each day; a shift running through midnight is split there.'),
    d('drops', 'Dropped calls', 'Calls reserved to the agent that ended because their station disconnected mid-call.'),
    d('callbacks_booked', 'Callbacks booked', 'The agent\'s calls in the window that ended with a callback time set.'),
    d('callbacks_on_time', 'Callbacks kept on time', `Of the callbacks the agent booked that were due in the window, those whose follow-up call was dialled no later than ${ON_TIME} minutes after the booked time (an early call counts as on time), whoever dialled it.`),
    d('callbacks_late', 'Callbacks kept late', `Callbacks the agent booked, due in the window, whose follow-up call was dialled more than ${ON_TIME} minutes after the booked time.`),
    d('callbacks_missed', 'Callbacks missed', 'Callbacks the agent booked, due in the window, that were never dialled because the contact was closed first or the campaign ended.'),
    d('callbacks_pending', 'Callbacks pending', 'Callbacks the agent booked, due in the window, that have not been dialled yet: upcoming while the booked time is still ahead, overdue once it has passed.'),
    d('redials', 'Wrap-up redials', 'Redials the agent placed from wrap-up, and how many of them connected.'),
    d('agent_retries', 'Agent retries', 'Dials the agent asked for themselves: contacts they reopened and numbers they dialled by hand.'),
    d('overrides', 'Overrides used', 'Dials that used an outcome override (an extra attempt, an early retry or calling outside hours).'),
    d('dnc_marked', 'Do Not Call marks', 'Numbers the agent added to the Do Not Call list.'),
    d('softphone_calls', 'Soft-phone calls', 'Calls the agent placed on the soft phone. They are outside every campaign figure above.'),
  ];
  if (audience === 'supervisor') {
    out.push(
      d('floor_comparison', 'Floor comparison', `The agent's figures against the middle half (25th to 75th percentile) of the account's agents who dialled in the same window. Only agents with at least ${ROSTER_FLOOR} first dials are compared; for the success rate and handle time they also need ${ROSTER_FLOOR} connected calls.`),
      d('sentiment', 'Call sentiment', 'The overall sentiment the call analysis gave each analysed call. A call analysed as mixed is counted as neutral.'),
    );
  }
  return out;
}

/** The campaign report's definitions, in print order. */
export function campaignDefinitions(): ReportDefinition[] {
  return [
    d('dials', 'Dials', 'Every call placed in the window, wrap-up redials included.'),
    d('first_dials', 'First dials', 'Dials that were not wrap-up redials: the connect rate\'s denominator.'),
    d('connected', 'Connected', 'Calls answered and bridged to an agent, not counting wrap-up redials.'),
    d('conversations', 'Conversations', 'Calls an agent spoke on, a wrap-up redial chain once: the success rate\'s denominator.'),
    d('connect_rate', 'Connect rate', `People reached ÷ first dials. A person is reached when a conversation is closed with an outcome other than voicemail or "no outcome". Shown in words below ${INSIGHTS_FLOOR} first dials.`),
    d('success_rate', 'Success rate', `Successes ÷ conversations, by the campaign's current outcome list. Shown in words below ${INSIGHTS_FLOOR} conversations.`),
    d('abandonment_rate', 'Abandonment rate', `Answered calls that reached no agent ÷ answered calls. Shown in words below ${INSIGHTS_FLOOR} answered calls.`),
    d('talk_time', 'Talk time', 'The agent\'s leg of each connected call, from the bridge to the end of the call; calls the system closed after a fault are left out.'),
    d('wrapup_time', 'Wrap-up time', 'Measured wrap-up, over wrap-ups that ended with a submitted outcome, an early return or an automatic return.'),
    ...CALLBACK_DEFINITIONS,
    d('agents_online_peak', 'Agents online (peak)', 'The most agents logged in to the campaign at the same moment in the day.'),
    d('best_hours', 'Best hours', 'Dials and people reached by the hour of day in each contact\'s own time zone (the campaign\'s when the contact has none).'),
    d('stalls', 'Stalled minutes', 'Minutes in which at least half of the dialler\'s checks on the running campaign placed no call, by the main reason.'),
    d('predial_blocks', 'Blocked before dialling', 'Contacts the dialler skipped because they were on the Do Not Call list, had an invalid number, or were outside calling hours.'),
    d('recording_share', 'Recording share', 'Connected calls with a recording ÷ connected calls.'),
  ];
}

/** The account report's definitions, in print order. */
export function accountDefinitions(): ReportDefinition[] {
  return [
    ...campaignDefinitions().filter((x) => !['best_hours', 'agents_online_peak', 'stalls', 'callbacks_on_time', 'callbacks_late', 'callbacks_missed', 'callbacks_pending'].includes(x.key)),
    d('totals', 'Account totals', 'Each figure summed over the covered campaigns; every rate of the totals is worked out again from the summed counts, never averaged across campaigns.'),
    d('agent_rates', 'Agent rates', `Each agent's connect rate (people reached ÷ first dials), success rate (successes ÷ connected calls) and handle time ((talk + wrap-up) ÷ connected calls) over all the account's campaigns. Shown in words below ${ROSTER_FLOOR} first dials.`),
    d('occupancy', 'Occupancy (handling)', '(Talk time + wrap-up time) ÷ logged-in time, breaks included, from the recorded state changes.'),
    d('floor_comparison', 'Floor comparison', `The middle half (25th to 75th percentile) of the account's agents who dialled in the window, over agents with at least ${ROSTER_FLOOR} first dials.`),
  ];
}
