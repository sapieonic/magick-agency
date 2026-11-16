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

/** The listening bar's notice (LS6). Always shown while the bar is, never dismissible. */
export const LISTEN_SESSION_NOTICE = 'This session is logged. Do not record or share what you hear.';

/** The first-use confirmation (LS6), once per browser. */
export const LISTEN_CONFIRM = {
  title: 'Listening is logged',
  message: 'Each time you listen, your name, the call and the start and end times are recorded in the activity history.',
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
  unknownCaller: 'Unknown caller',
  callEnded: 'Call ended',
  listen: 'Listen',
  stop: 'Stop',
  connecting: 'Connecting…',
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

/** "N in progress". */
export function inProgressLabel(count: number): string {
  return `${count} in progress`;
}

/** "Updated N s ago", whole seconds, never negative. */
export function updatedAgoLabel(seconds: number): string {
  return `Updated ${Math.max(0, Math.floor(seconds))} s ago`;
}

/** Why Listen is disabled on a row (the grant's own refusal, LS3, LS4, LS5). */
export const NOT_LISTENABLE_COPY: Record<AgencyLiveCallNotListenableReason, string> = {
  listen_recording_off: 'Listening is turned off for unrecorded calls',
  listen_limit_call: 'Two supervisors are already listening',
  listen_own_call: 'You are on this call',
};

/** A row that is not listenable for a reason the list did not name. */
export const NOT_LISTENABLE_FALLBACK = 'You cannot listen to this call';

export function notListenableCopy(reason: AgencyLiveCallNotListenableReason | null): string {
  return reason ? NOT_LISTENABLE_COPY[reason] : NOT_LISTENABLE_FALLBACK;
}

/** A refused grant or upgrade, by its code (`errors.ts` §7): the toast or the bar says it. */
export const LISTEN_REFUSAL_COPY: Record<AgencyListenErrorCode, string> = {
  listen_call_not_live: 'That call has ended.',
  listen_recording_off: 'Listening is turned off for unrecorded calls.',
  listen_limit_call: 'Two supervisors are already listening to that call.',
  listen_limit_server: 'Listening is busy right now. Try again in a minute.',
  listen_own_call: 'You are on this call.',
  listen_unavailable: 'Listening is not available right now. Try again.',
};

/** Refusals that are not listen codes: the flag (`feature_disabled`), the permission, the network. */
export const LISTEN_REFUSAL_FALLBACK = {
  featureDisabled: 'Listening is turned off for this account.',
  forbidden: 'You do not have access to listen to calls.',
  network: 'Could not start listening. Check your connection and try again.',
  other: 'Could not start listening. Try again.',
} as const;

/** The listening bar's words, by state. */
export const LISTEN_BAR_COPY = {
  region: 'Listening bar',
  connecting: 'Connecting…',
  listening: 'Listening',
  reconnecting: 'Reconnecting…',
  reconnectingDetail: 'Trying again for up to 15 s. The call itself is not affected.',
  lost: 'Connection lost',
  tryAgain: 'Try again',
  callEnded: 'Call ended',
  stopped: 'Listening stopped',
  revoked: 'You no longer have access to listen to calls.',
  superseded: 'Listening moved to another call.',
  soundBlocked: 'Your browser blocked the sound. Click to turn it on.',
  turnSoundOn: 'Turn sound on',
  agentReconnecting: 'Agent reconnecting…',
  agent: 'Agent',
  customer: 'Customer',
  volume: 'Volume',
  openCall: 'Open call',
  stop: 'Stop listening',
  stopShort: 'Stop',
  dismiss: 'Dismiss',
} as const;

/** "Call ended · you listened for mm:ss". */
export function listenedForLabel(ms: number): string {
  return `${LISTEN_BAR_COPY.callEnded} · you listened for ${formatClock(ms)}`;
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
  return call.origin === 'manual' ? LIVE_CALLS_COPY.softPhone : 'Unnamed campaign';
}

/** The customer's name, or "Unknown caller". */
export function customerLabel(call: Pick<AgencyLiveCall, 'customer_name'>): string {
  const name = call.customer_name?.trim();
  return name ? name : LIVE_CALLS_COPY.unknownCaller;
}

/** The agent's short name for the bar: "Priya S." from "Priya Sharma"; one word stays whole. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words[0] ?? name;
  const last = words[words.length - 1]!;
  return `${words[0]} ${Array.from(last)[0]!.toUpperCase()}.`;
}

/**
 * The words for a refused grant or upgrade: its code's, else the status's. A 503 without a listen
 * code reads as `listen_unavailable`: the server's error mask strips the body of every 5xx it has
 * not reviewed, which today includes the grant's own `listen_limit_server` and
 * `listen_unavailable`, and a worker restarting answers `worker_unavailable`.
 */
export function listenRefusalMessage(refusal: { status: number | null; code: string | null }): string {
  const code = refusal.code;
  if (code && code in LISTEN_REFUSAL_COPY) return LISTEN_REFUSAL_COPY[code as AgencyListenErrorCode];
  if (code === 'feature_disabled') return LISTEN_REFUSAL_FALLBACK.featureDisabled;
  if (refusal.status === 401 || refusal.status === 403) return LISTEN_REFUSAL_FALLBACK.forbidden;
  if (refusal.status === 503) return LISTEN_REFUSAL_COPY.listen_unavailable;
  if (refusal.status === null) return LISTEN_REFUSAL_FALLBACK.network;
  return LISTEN_REFUSAL_FALLBACK.other;
}
