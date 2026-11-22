import type { AgencyInboundStickyReason } from '../../types/inbound';
import type { DialBlockReason } from '../softphone/phoneInput';
import { STATION_BLOCK_COPY } from './stationCopy';

/**
 * The words of the station's two side views, an inbound call and the soft phone, in the
 * station's look (AS15): simple Indian English, short sentences, British spelling, and none of the
 * spec's §6.6 jargon (no disposition, campaign, callback, DNC, route, soft phone, …). Keyed on a
 * code or a state, never on a sentence a hook or the server wrote. The station's own words
 * (`stationCopy.ts`) are used where they already say it; these are only the side views' extra.
 */
export const SIDE_COPY = {
  // The caller and the customer card
  numberHidden: 'Number hidden',
  aboutCall: 'About this call',
  theyCalled: 'They called',
  line: 'Line',
  waited: 'Waited',
  work: 'Work',
  noWork: 'Not in any work',
  newCaller: 'We do not know this number. Ask the customer’s name and write it in the note.',
  hiddenCaller: 'The number is hidden. Ask the customer’s name and number and write them in the note.',
  dncBadge: 'Asked not to be called',
  dncEnquiry: 'This customer asked us not to call. They called us, so help them now. Do not call them back unless they ask.',
  otherAgentsCustomer: 'Usually talks to another agent, who is busy',

  // What happened? on a side view
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveOpensAfterCall: 'Save opens when the call ends.',
  fillCallDetails: 'Fill in the call details first.',
  closesAt: (time: string) => `If you do not choose, this call closes at ${time}.`,
  closing: 'Closing…',
  stopBodyWork: (work: string) => `We will not call this number again for ${work}. You cannot change this later.`,
  stopBodyAll: 'We will not call this number again for any work in this account. You cannot change this later.',
  stoppedCalls: 'We will not call this number again.',
  callBackYourself: (when: string) => `This time is saved with the call. No one will call by themselves, so call back ${when} yourself.`,
  stopFailed: 'That did not go through. Try again.',
  endCallFailed: 'The call did not end. Try again.',
  // Said once to a screen reader, or shown, by the side views' hooks (`useSoftphone`, `useInboundCall`)
  savedAnnounce: 'Saved.',
  notSaved: (why: string) => `It did not save. ${why}`,
  mutedAtAnswer: 'You are on mute. The customer cannot hear you. Press M to talk.',
  notesOpenOnCall: 'You can write a note once a call starts.',
  padOpensOnAnswer: 'You can choose once the customer picks up.',
  padOpensOnConnect: 'You can choose once you are talking to the customer.',
  finishCallFull: 'The soft phone is turned off. Finish this call and save it. You cannot dial new calls.',
  finishIdlePage: 'The soft phone is turned off. You cannot dial new calls. Close the soft phone when you are done.',
  softphoneDidNotLoad: 'The soft phone did not load. Try again.',
  recentDidNotLoad: 'We could not load your recent calls.',
  overrideNoteInvalid: 'Write a note of 10 to 500 letters.',

  // The dial pad
  number: 'Number',
  numberPlaceholder: 'Type the number',
  countryCodeHint: 'A number without a country code uses this one',
  deleteDigit: 'Delete last digit',
  keypad: 'Keypad',
  dialForm: 'Dial a number',
  call: 'Call',
  placing: 'Calling…',
  callFrom: 'Call from',
  automaticHint: 'Automatic: the number of the customer’s own agent if they have one, else one of the work’s numbers.',
  pickedHintWork: (work: string) => `One of ${work}’s numbers. If the customer has their own agent’s number, the call goes from that one.`,
  pickedHintOwn: 'One of your account’s numbers.',
  lastCallLine: (number: string, how: string) => `Last call to ${number}: ${how}`,
  automatic: 'Automatic',
  noNumbers: 'No numbers to call from',
  pasteWorks: 'You can paste a number too.',
  saveTo: 'Save this call to',
  noWorkOption: 'Not in any work',
  // Every call must be saved to a work (the account's setting, docs/call-log.md §5; AS15's words
  // for the proposal's "Log to (required)" and "Choose a campaign to log this call to.").
  required: '(required)',
  chooseWork: 'Choose the work',
  chooseWorkHint: 'Choose the work to save this call to.',
  noRunningWorkTitle: 'You are not in any work that is running, so you cannot dial.',
  noRunningWorkBody: 'Ask your supervisor to add you to one.',
  redialNoWork: 'This call was not saved to any work. Choose one to call again.',
  // A call from a customer, saved under a work (docs/call-log.md §5).
  filedUnder: 'Filed under',
  notOnAnyList: 'This number is not on any list',
  changeWork: 'Change',
  changeWorkLabel: 'Change the work this call is filed under',
  changingWork: 'Changing…',
  choicesChanged: (work: string) => `What you can choose changed to match ${work}.`,
  chooseWorkToSave: 'Choose the work to file this call under, then save.',
  worksDidNotLoad: 'We could not load your work. Try again.',
  callDetails: 'Call details',
  recentCalls: 'My recent calls',
  recentEmpty: 'Numbers you dial show here. Press one to dial it again.',
  recentFailed: 'We could not load your recent calls.',
  recentLoading: 'Loading…',
  redial: (number: string) => `Put ${number} in the number box again`,
  callingFrom: (number: string) => `From ${number}`,
  ringing: 'Ringing',
  dialling: 'Calling',
  muteRing: 'Mute ring',
  unmuteRing: 'Unmute ring',
  ringingWarning:
    'If you stop now, the customer’s phone may keep ringing for some time. If they pick up, they will hear nothing. Stop only if you must.',
  notConnected: 'Wait for the internet to come back.',
  connectingPhone: 'Connecting your phone…',
  loading: 'Loading…',
  noCallerId: 'There is no number to call from. Ask your supervisor.',
  callGoingOn: 'A call is going on now.',
  finishCall: 'Dialling is turned off. Finish this call and save it.',
  finishIdle: 'Dialling is turned off. Press Back to my calls when you are ready.',
  outsideHours: 'It is outside this work’s calling hours. You may have to say why you are calling.',
  inboundNotHere: 'Customers who call us do not ring here. Go back to your calls to take them.',
  inboundNotHerePage: 'Customers who call us do not ring here. Open today’s work to take them.',
  softphonePageWork: 'Soft phone',
  closeSoftphone: 'Close soft phone',
  closeSoftphoneTitle: 'Close the soft phone?',
  closingSoftphone: 'Closing…',
  notSavedYet: 'Not saved yet',
  onACallNow: 'On a call now',
  didNotLoad: 'This did not load.',
  tryAgain: 'Try again',
} as const;

/**
 * `/dialer/phone`'s screens before the soft phone opens, in the station's look and words (AS15):
 * opening, did not open, open in another account (turned off here, or on), and the agent still on
 * their calls. Keyed on a state or a code; the place names (`account`, `work`) are names, never a
 * sentence the server wrote.
 */
export const SOFTPHONE_PAGE_COPY = {
  openingTitle: 'Opening your soft phone',
  openingSubtitle: 'One moment.',
  openingBody: 'Opening your soft phone…',
  failedTitle: 'Your soft phone did not open',
  failedSubtitle: 'See why below.',
  failedNoAnswer: 'We could not reach the server. Check your internet, then try again.',
  tryAgain: 'Try again',
  elsewhereTitle: 'Your soft phone is open in another account',
  elsewhereSubtitle: 'You can use it in one place at a time.',
  elsewhereBody: (account: string | null) =>
    account ? `Your soft phone is open in ${account}.` : 'Your soft phone is open in another account of this organisation.',
  elsewhereClose: 'Close it and open the soft phone here',
  closing: 'Closing…',
  elsewhereCallOpen: (account: string | null) =>
    `Your soft phone ${account ? `in ${account}` : 'in the other account'} has a call that is not finished, so it is still open. Hang up and save what happened there first.`,
  goThere: (account: string | null) => (account ? `Use the soft phone in ${account}` : 'Use the soft phone in that account'),
  strandedSubtitle: 'It is turned off here. Close it to start work again.',
  strandedBody: 'The soft phone is turned off for this account, and it is still open in another account of this organisation. Go to that account to finish there, or close it here.',
  strandedOwed: 'Your last call there is not saved yet. A supervisor can save what happened for you.',
  strandedClose: 'Close it here so you can start work.',
  onCallsTitle: 'You are still on your calls',
  onCallsSubtitle: 'You can use one at a time.',
  onCallsDoing: (work: string, account: string | null, doing: string) =>
    account ? `You are on ${work} in ${account}, ${doing}.` : `You are on ${work}, ${doing}.`,
  onCallsAfterCall: 'The soft phone opens after this call, once you save what happened. You can go back to your calls from it.',
  onCallsNow: 'Open the soft phone instead. You can go back to your calls from it.',
  onCallsMoves: (account: string) => `This takes you to ${account}.`,
  useSoftphone: (account: string | null) => (account ? `Use the soft phone in ${account}` : 'Use the soft phone'),
  switching: 'Opening…',
  goToCalls: (work: string, account: string | null) => (account ? `Open ${work} in ${account}` : `Open ${work}`),
  onCallsCannotMove: (work: string, account: string | null) =>
    `You are working on ${work} in ${account ?? 'another account'}. Go to that account to use the soft phone there.`,
} as const;

/** Why this caller is the agent's own customer (`sticky.reason`), in the station's words. */
export const STICKY_WORDS: Record<AgencyInboundStickyReason, string> = {
  owner: 'Your customer. They are on your list.',
  last_from_number: 'Your customer. You called them last time.',
  last_connected: 'Your customer. You spoke to them last time.',
  last_dialled: 'Your customer. You called them last time.',
};

/** Why the number typed cannot be called yet (`DialBlockReason`). */
export const DIAL_BLOCK_WORDS: Record<DialBlockReason, string> = {
  empty: 'Type the number, then press Call.',
  too_short: 'This number is too short.',
  too_long: 'This number is too long.',
  not_a_number: 'Take out * and #. Then press Call.',
};

/**
 * Why Save cannot save yet on a side view (`InboundSaveBlock`, the soft phone's `SaveBlock`): the
 * station's own words for the outcome's blocks, and two of the side views' own.
 */
export type SideSaveBlock = keyof typeof STATION_BLOCK_COPY | 'call_live' | 'fields_required' | 'work_required';

export function sideSaveBlockLine(block: SideSaveBlock): string {
  if (block === 'call_live') return SIDE_COPY.saveOpensAfterCall;
  if (block === 'work_required') return SIDE_COPY.chooseWorkToSave;
  if (block === 'fields_required') return SIDE_COPY.fillCallDetails;
  return STATION_BLOCK_COPY[block];
}

/** "0:42", or "1:05": how long the caller waited before the call came to the agent. */
export function waitedFor(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
