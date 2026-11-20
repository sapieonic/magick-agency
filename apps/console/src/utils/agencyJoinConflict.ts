import type { AgencyAgentState, AgencySessionConflict } from '../types/agency';

/**
 * The `409 session_on_other_campaign` refusal from `POST /proxy/agency/sessions`
 * — parsed, and turned into something the agent can act on.
 *
 * ── Why this one error gets its own module ──────────────────────────────────
 * It is the *only* new refusal the one-live-session-per-agent-per-tenant rule
 * makes reachable, and it is reachable by an ordinary agent doing nothing wrong:
 * a supervisor reassigns them, they open the app, and the campaign they are sent
 * to refuses them because they are still joined to yesterday's. Rendered through
 * the page's generic catch that reads `err.message`, it would say "Conflict" —
 * a wire token, with no campaign named and no remedy.
 *
 * The remedy is specific and the console knows it: leave *that* list, or finish
 * the call there first. So the join screen (`StationJoinScreens`) names the list,
 * says what they are doing there, and offers the switch or a link to it.
 *
 * The server forwards the dialer runtime's body unchanged (status **and** body), so the shape below
 * is the dialer runtime's `AgencySessionCampaignConflict`, not a server invention.
 *
 * **How it survives the API's error mask is worth knowing exactly**, because the
 * seam is thin: it is NOT that the body carries `details` — it carries none, and
 * the API's own test asserts their absence. It survives solely because
 * `session_on_other_campaign` reaches `FORWARDABLE_ERROR_CODES` through the
 * `AGENCY_ACTION_ERROR_CODES` spread. That allow-list entry is the only thing
 * holding this screen up; delete it and every field below arrives masked, this
 * parser returns `null`, and the agent gets a support message instead of a
 * remedy.
 *
 * The parse is duck-typed rather than `instanceof ApiError` so this module has no
 * dependency on the server and can be unit-tested against a plain object —
 * the same reason `agencyCampaignRecording.ts` reads errors that way.
 */

interface ErrorShape {
  statusCode?: number;
  details?: unknown;
}

const AGENT_STATES: ReadonlySet<string> = new Set<AgencyAgentState>([
  'offline',
  'available',
  'reserved',
  'on_call',
  'wrapup',
  'break',
]);

/**
 * `null` for anything that is not this refusal — including a 409 whose `code`
 * says something else. A conflict we cannot fully read is **not** rendered as a
 * partial one: a screen that names no campaign is worse than the generic error,
 * because it looks like it was supposed to say something and did not.
 */
export function parseJoinConflict(err: unknown): AgencySessionConflict | null {
  if (err === null || typeof err !== 'object') return null;
  const shaped = err as ErrorShape;
  if (shaped.statusCode !== 409) return null;

  const body = shaped.details;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  if (record['code'] !== 'session_on_other_campaign') return null;
  const campaignId = record['campaign_id'];
  const campaignName = record['campaign_name'];
  const state = record['state'];
  // Trimmed-empty is as unreadable as absent, and it is the one that gets
  // through a type check: `campaign_name: ''` renders "You’re joined to  —
  // available." with an "Open " link — the exact screen this refusal exists to
  // prevent. The `message` fallback below already reads emptiness this way.
  if (typeof campaignId !== 'string' || campaignId.trim().length === 0) return null;
  if (typeof campaignName !== 'string' || campaignName.trim().length === 0) return null;
  if (typeof state !== 'string' || !AGENT_STATES.has(state)) return null;

  const message = record['message'];

  return {
    error: typeof record['error'] === 'string' ? record['error'] : 'Conflict',
    code: 'session_on_other_campaign',
    campaign_id: campaignId,
    campaign_name: campaignName,
    state: state as AgencyAgentState,
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/**
 * Whether the agent is mid-call on the OTHER campaign right now.
 *
 * The one fact that decides whether this screen may offer to leave that
 * station on the agent's behalf: `reserved`/`on_call`/`wrapup` mean a live
 * customer (or one they still owe a disposition), and nothing on this screen
 * should be able to drop that without the agent physically going there. A
 * shared predicate rather than two copies, because the join screen's remedy
 * sentence and its "Leave and work here" button (`StationJoinScreens`) gate on
 * exactly the same condition and must never drift apart.
 */
export function conflictIsMidCall(state: AgencyAgentState): boolean {
  return state === 'reserved' || state === 'on_call' || state === 'wrapup';
}

/**
 * Which of the three chained requests `useStationJoin`'s `confirmSwitch` failed
 * at — resuming the other campaign's session (to learn its `session_id`,
 * which the conflict body never carries), leaving it, or rejoining this one.
 * Each needs a different sentence: a failure at `resume` left nothing changed,
 * one at `leave` means the agent is still on the other station exactly as
 * before, and one at `rejoin` means they have already left it and are
 * currently at NEITHER station. The sentences are `switchFailedLine`
 * (`utils/agency/stationCopy.ts`, AS15).
 */
export type SwitchStage = 'resume' | 'leave' | 'rejoin';
