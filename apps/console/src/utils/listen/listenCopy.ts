import type {
  AgencyCallOrigin,
  AgencyListenErrorCode,
  AgencyLiveCall,
  AgencyLiveCallNotListenableReason,
} from '../../types/live-calls';

/**
 * Every word live call listening shows (`docs/listening.md` §9, decisions LS2, LS3, LS4, LS6), in
 * one place so the table, the bar, the toasts and the tests say the same thing. British English;
 * the wire codes they translate are never respelled.
 */

/** The agent's standing line (LS2): the console station and the mobile app's station info sheet. */
export const LISTEN_AGENT_NOTICE = 'Calls may be listened to by a supervisor for quality and training.';

/**
 * The info button that opens the standing line on the station and the soft phone, and the
 * popover's heading. Named for what it is about, so an agent looking for it finds it.
 */
export const LISTEN_AGENT_INFO_LABEL = 'Monitoring and recording';

/**
 * The one-time notice under the station's or the soft phone's header, the first time this agent
 * opens either in this browser for this account while listening is on, until they dismiss it.
 */
export const LISTEN_AGENT_FIRST_NOTICE = {
  region: 'About supervisors listening',
  detail: `You can read this again at any time under ${LISTEN_AGENT_INFO_LABEL}, the i button at the top of the screen.`,
  dismiss: 'Got it',
} as const;

/** The listening bar's notice (LS6). Always shown while the bar is, never dismissible. */
export const LISTEN_SESSION_NOTICE = 'This session is logged. Do not record or share what you hear.';

/** The first-use confirmation (LS6), once per browser. */
export const LISTEN_CONFIRM = {
  title: 'Listening is logged',
  message: 'Each time you listen, your name, the call and the start and end times are recorded and can be seen by your account’s admins.',
  cancel: 'Cancel',
  confirm: 'Start listening',
} as const;

export const LIVE_CALLS_COPY = {
  title: 'Live calls',
  emptyTitle: 'No calls in progress',
  emptyBody: 'Calls appear here as soon as an agent is connected to a customer.',
  error: 'Could not load live calls. Retrying…',
  noPermission: 'You can see live calls but not listen to them.',
  forbidden: 'Live calls are for supervisors. Ask an account admin if you need to see them.',
  /** An inbound caller with no name we know. */
  unknownCaller: 'Unknown caller',
  /** A number we dialled (dialler or soft phone) with no name on it. */
  noName: 'No name',
  unnamedCampaign: 'Unnamed campaign',
  noMatch: 'No calls in progress match these filters.',
  clearFilters: 'Clear filters',
  filters: 'Filter live calls',
  campaignFilter: 'Campaign',
  allCampaigns: 'All campaigns',
  agentFilter: 'Agent',
  allAgents: 'All agents',
  typeFilter: 'Type',
  captionCampaign: 'Calls in progress on this campaign, longest on call first',
  captionAccount: 'Calls in progress in this account, longest on call first',
  columnAgent: 'Agent',
  columnCustomer: 'Customer',
  columnCampaign: 'Campaign',
  columnType: 'Type',
  columnTime: 'Time on call',
  columnRecording: 'Recording',
  columnListening: 'Listening',
  columnAction: 'Action',
  /** A listener the list could not name. */
  aSupervisor: 'A supervisor',
  you: 'You',
  callEnded: 'Call ended',
  listen: 'Listen',
  stop: 'Stop',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  listening: 'Listening',
  show: 'Show',
  hide: 'Hide',
  numberFailed: 'Could not show the number. Try again.',
  recording: 'Recording',
  recordingOff: 'Recording off',
  mobileApp: 'Mobile app',
  softPhone: 'Soft phone',
  inbound: 'Inbound',
  overrun: 'On the call past twice the campaign’s average handle time',
  openCall: 'Open call',
} as const;

/**
 * The account page's intro (`PageDescription`) and its tips: what the page is, and that listening
 * is silent and logged.
 */
export const LIVE_CALLS_PAGE_COPY = {
  description:
    'The calls in progress in this account: who is on each one, with whom, for how long, whether it is being recorded and who '
    + 'is listening. Supervisors with permission can listen in. Nobody on the call hears you, and every listen is logged.',
  tips: [
    'Numbers are masked. Show reveals one row’s full number while you are on this page.',
    'Every listen is logged with your name, the call and when you started and stopped.',
    'The listening bar stays at the bottom of the console while you move between pages.',
  ],
} as const;

/** "N in progress". */
export function inProgressLabel(count: number): string {
  return `${count} in progress`;
}

/** "Updated just now" under a second, then "Updated N s ago", whole seconds. */
export function updatedAgoLabel(seconds: number): string {
  const whole = Math.floor(seconds);
  return whole < 1 ? 'Updated just now' : `Updated ${whole} s ago`;
}

/** "Listen to Priya Sharma’s call" (the row's Listen). */
export function listenToLabel(agent: string): string {
  return `Listen to ${agent}’s call`;
}

/** "Show number for Rahul Mehta" / "Hide number for …" (the row's Show/Hide). */
export function revealLabel(shown: boolean, customer: string): string {
  return `${shown ? LIVE_CALLS_COPY.hide : LIVE_CALLS_COPY.show} number for ${customer}`;
}

/** "Open call: Priya Sharma with Rahul Mehta" (the row's Open call). */
export function openCallLabel(agent: string, customer: string): string {
  return `${LIVE_CALLS_COPY.openCall}: ${agent} with ${customer}`;
}

/** The listening stack's overflow: "+2" past the avatars shown. */
export function moreListenersLabel(count: number): string {
  return `+${count}`;
}

/** "Stop listening to Priya Sharma’s call" (the row's Stop while connecting). */
export function stopListeningToLabel(agent: string): string {
  return `Stop listening to ${agent}’s call`;
}

/**
 * "2 supervisors are already listening", counted from the row's listeners (never the cap, which is
 * configurable); null with none to count.
 */
export function alreadyListeningLabel(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !(count > 0)) return null;
  return count === 1 ? '1 supervisor is already listening' : `${count} supervisors are already listening`;
}

/** Why Listen is disabled on a row (the grant's own refusal, LS3, LS4, LS5). */
export const NOT_LISTENABLE_COPY: Record<AgencyLiveCallNotListenableReason, string> = {
  listen_recording_off: 'Listening is turned off for unrecorded calls',
  listen_limit_call: 'This call has reached its listening limit',
  listen_own_call: 'You are on this call',
};

/** A row that is not listenable for a reason the list did not name. */
export const NOT_LISTENABLE_FALLBACK = 'You cannot listen to this call';

/** Why Listen is disabled; a full call counts its listeners (`listenerCount`, the row's) where it can. */
export function notListenableCopy(reason: AgencyLiveCallNotListenableReason | null, listenerCount?: number): string {
  if (reason === 'listen_limit_call') return alreadyListeningLabel(listenerCount) ?? NOT_LISTENABLE_COPY.listen_limit_call;
  return reason ? NOT_LISTENABLE_COPY[reason] : NOT_LISTENABLE_FALLBACK;
}

/** A refused grant or upgrade, by its code (`errors.ts` §7): the toast or the bar says it. */
export const LISTEN_REFUSAL_COPY: Record<AgencyListenErrorCode, string> = {
  listen_call_not_live: 'That call has ended.',
  listen_recording_off: 'Listening is turned off for unrecorded calls.',
  listen_limit_call: 'That call has reached its listening limit.',
  listen_limit_server: 'Too many calls are being listened to right now. Try again in a minute.',
  listen_own_call: 'You are on this call.',
  listen_unavailable: 'Listening is not available right now. Try again.',
};

/**
 * Refusals that are not listen codes: the flag (`feature_disabled`), the permission, the network,
 * and a browser that cannot play the sound (no Web Audio, or no context to be had), which the
 * console refuses itself before minting a grant.
 */
export const LISTEN_REFUSAL_FALLBACK = {
  featureDisabled: 'Listening is turned off for this account.',
  forbidden: 'You do not have access to listen to calls.',
  network: 'Could not start listening. Check your connection and try again.',
  other: 'Could not start listening. Try again.',
  noAudio: 'This browser cannot play the call’s sound, so you cannot listen here.',
} as const;

/** The listening bar's words, by state. */
export const LISTEN_BAR_COPY = {
  region: 'Listening bar',
  connecting: 'Connecting…',
  listening: 'Listening',
  reconnecting: 'Reconnecting…',
  reconnectingDetail: 'Trying again for up to 15 s. The call itself is not affected.',
  lost: 'Connection lost',
  /** Under "Connection lost": what a supervisor worries about first. */
  lostDetail: 'The call is not affected.',
  tryAgain: 'Try again',
  /** "Connection lost": nothing is left to stop, so the bar is put away, not stopped. */
  close: 'Close',
  callEnded: 'Call ended',
  /** The call was gone before the first `ready` (4404 on the first attach): nothing was heard. */
  endedBeforeJoin: 'The call ended before you joined.',
  stopped: 'Listening stopped',
  revoked: 'You no longer have access to listen to calls.',
  /** The flag went off (this console saw it, or a re-grant was refused `feature_disabled`). */
  turnedOff: 'Listening has been turned off for this account.',
  /**
   * The server's `superseded`: this shell stops its own first listen before a second starts, so a
   * supersede it hears of was started elsewhere: another tab or window.
   */
  superseded: 'You started listening in another tab or window, so it stopped here.',
  soundBlocked: 'Your browser has blocked the sound.',
  turnSoundOn: 'Turn sound on',
  /** The agent's leg has sent nothing for over 2 s: a muted console agent sends nothing, so not "reconnecting". */
  agentSilent: 'No sound from the agent',
  levels: 'Levels',
  agent: 'Agent',
  customer: 'Customer',
  volume: 'Volume',
  openCall: 'Open call',
  stop: 'Stop listening',
  stopShort: 'Stop',
  dismiss: 'Dismiss',
} as const;

/**
 * "Priya S. with ****4321 · you listened for 02:10" under the bar's "Call ended" head, or, with no
 * `who` (at phone width, where there is no head), "Call ended · you listened for 02:10".
 */
export function listenedForLabel(ms: number, who?: string): string {
  return `${who ?? LISTEN_BAR_COPY.callEnded} · you listened for ${formatClock(ms)}`;
}

/** "Priya S. with ****4321": who the bar is listening to. */
export function listenWhoLabel(agentName: string, customerMasked: string): string {
  return `${shortName(agentName)} with ${customerMasked}`;
}

/** Mute toggle's accessible name. */
export function muteLabel(leg: 'agent' | 'customer', muted: boolean): string {
  const who = leg === 'agent' ? 'the agent' : 'the customer';
  return muted ? `Unmute ${who}` : `Mute ${who}`;
}

/**
 * A duration as `mm:ss`, or `h:mm:ss` from an hour. Whole seconds, floored; negative and
 * unreadable values read as `00:00` (a clock running backwards is never shown).
 */
export function formatClock(ms: number | null | undefined): string {
  const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** The Type badge's word. */
export const ORIGIN_LABELS: Record<AgencyCallOrigin, string> = {
  campaign: 'Dialler',
  manual: 'Soft phone',
  inbound: 'Inbound',
};

/**
 * The Campaign column: the campaign's name; a soft-phone call not logged to one is "Soft phone";
 * an inbound call is "Inbound: <route>".
 */
export function campaignCellLabel(call: Pick<AgencyLiveCall, 'origin' | 'campaign_name' | 'inbound_route_name'>): string {
  if (call.origin === 'inbound') {
    return call.inbound_route_name ? `${LIVE_CALLS_COPY.inbound}: ${call.inbound_route_name}` : LIVE_CALLS_COPY.inbound;
  }
  if (call.campaign_name) return call.campaign_name;
  return call.origin === 'manual' ? LIVE_CALLS_COPY.softPhone : LIVE_CALLS_COPY.unnamedCampaign;
}

/**
 * The customer's name; without one, "Unknown caller" for a caller who rang in, and "No name" for a
 * number we dialled (we know who we called, just not their name).
 */
export function customerLabel(call: Pick<AgencyLiveCall, 'customer_name' | 'origin'>): string {
  const name = call.customer_name?.trim();
  if (name) return name;
  return call.origin === 'inbound' ? LIVE_CALLS_COPY.unknownCaller : LIVE_CALLS_COPY.noName;
}

/** "Listened to by" on a call's page (LS13). */
export const LISTENED_TO_BY_COPY = {
  title: 'Listened to by',
  /** A listener the read could not name. */
  aSupervisor: 'A supervisor',
  /** A session still open. */
  listeningNow: 'Listening now',
} as const;

/** "since 14:02": a session still open. */
export function listeningSinceLabel(clock: string): string {
  return `since ${clock}`;
}

/** The agent's short name for the bar: "Priya S." from "Priya Sharma"; one word stays whole. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words[0] ?? name;
  const last = words[words.length - 1]!;
  return `${words[0]} ${Array.from(last)[0]!.toUpperCase()}.`;
}

/**
 * The words for a refused grant or upgrade: its code's, else the status's. A call full of
 * listeners counts them when the caller knows how many the row had (`listenerCount`). The grant's own 503s
 * (`listen_limit_server`, `listen_unavailable`) arrive with their code: the route marks them
 * reviewed, so the server's error mask lets them through. A 503 without a listen code still reads
 * as `listen_unavailable`: a worker restarting answers `worker_unavailable`, and a 503 from in
 * front of the server has no body the console can read.
 */
export function listenRefusalMessage(refusal: { status: number | null; code: string | null }, listenerCount?: number): string {
  const code = refusal.code;
  if (code === 'listen_limit_call') {
    const already = alreadyListeningLabel(listenerCount);
    if (already) return `${already} to that call.`;
  }
  if (code && code in LISTEN_REFUSAL_COPY) return LISTEN_REFUSAL_COPY[code as AgencyListenErrorCode];
  if (code === 'feature_disabled') return LISTEN_REFUSAL_FALLBACK.featureDisabled;
  if (refusal.status === 401 || refusal.status === 403) return LISTEN_REFUSAL_FALLBACK.forbidden;
  if (refusal.status === 503) return LISTEN_REFUSAL_COPY.listen_unavailable;
  if (refusal.status === null) return LISTEN_REFUSAL_FALLBACK.network;
  return LISTEN_REFUSAL_FALLBACK.other;
}
