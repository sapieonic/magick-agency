import { AGENCY_FLOOR_STATE_LABELS } from './agencyAgentFloor';
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
 * The remedy is specific and the console knows it: go back to *that* station and
 * use Leave station. So the copy names the campaign, says whether they are
 * mid-call there, and the page renders a link to it.
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
 * The server's own sentence, out of a conflict body the parser **refused**.
 *
 * The pair is deliberate. `parseJoinConflict` stays strict — a screen shaped
 * like one that names a campaign, which then names none, looks broken — so a
 * body missing a structured field still falls through to the ordinary error
 * path. This is what that path is allowed to say once it gets there: The server now
 * sends a `message` on the 409, and its sentence beats the generic "Could not
 * join the campaign." by a distance.
 *
 * Deliberately NOT a general error reader: it is scoped to this `code`, so it
 * cannot drift into pulling sentences out of unrelated 409s (the console has
 * others — `break_already_applied` for one). `null` whenever there is nothing
 * better than the caller's own fallback, so the call site reads as a preference
 * rather than a branch.
 *
 * ── Honest about its own weight ────────────────────────────────────────────
 * Today this changes nothing on screen: `ApiError.extractMessage` already
 * prefers a body `message`, so the call site would render the same sentence
 * without it — which also means its tests cannot catch a revert of the line they
 * protect. It is kept because that precedence is `client.ts`'s business and not
 * a contract this feature can rely on: `extractMessage` reorders its branches
 * whenever a new error shape is added, and the sentence an agent reads on the
 * one refusal the 1:1 rule makes reachable should not depend on where `message`
 * happens to sit in that list. Read it as a pin on the requirement, not as
 * behaviour.
 */
export function joinConflictFallbackSentence(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null;
  const shaped = err as ErrorShape;
  if (shaped.statusCode !== 409) return null;

  const body = shaped.details;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  if (record['code'] !== 'session_on_other_campaign') return null;
  const message = record['message'];
  return typeof message === 'string' && message.trim().length > 0 ? message : null;
}

export interface JoinConflictCopy {
  headline: string;
  /** What is true right now, naming the campaign and their state on it. */
  detail: string;
  /** What to do about it. Separate from `detail` so the remedy is never skimmed past. */
  remedy: string;
  /** Label for the link back to the station they are still joined to. */
  linkLabel: string;
}

/**
 * Whether the agent is mid-call on the OTHER campaign right now.
 *
 * The one fact that decides whether this screen may offer to leave that
 * station on the agent's behalf: `reserved`/`on_call`/`wrapup` mean a live
 * customer (or one they still owe a disposition), and nothing on this screen
 * should be able to drop that without the agent physically going there. A
 * shared predicate rather than two copies, because `joinConflictCopy`'s remedy
 * sentence and `AgentConsolePage`'s "Leave & join here" button gate on exactly
 * the same condition and must never drift apart.
 */
export function conflictIsMidCall(state: AgencyAgentState): boolean {
  return state === 'reserved' || state === 'on_call' || state === 'wrapup';
}

/**
 * The copy.
 *
 * `state` is not decoration: an agent who is `on_call` on the other campaign must
 * not be told to go and leave it right now — that is a live customer. So the
 * remedy is conditional on the state, which is exactly why the server sends it.
 */
export function joinConflictCopy(conflict: AgencySessionConflict): JoinConflictCopy {
  const stateLabel = AGENCY_FLOOR_STATE_LABELS[conflict.state];
  const midCall = conflictIsMidCall(conflict.state);

  return {
    headline: 'You’re still at another station',
    detail: `You’re joined to ${conflict.campaign_name} — ${stateLabel.toLowerCase()}. You can only be at one station at a time.`,
    remedy: midCall
      ? `Finish what you’re doing on ${conflict.campaign_name}, leave that station, then come back here.`
      : `Leave ${conflict.campaign_name} first, then come back here.`,
    linkLabel: `Open ${conflict.campaign_name}`,
  };
}

/** Label for the one-click remedy button, shown only when `!conflictIsMidCall`. */
export function switchActionLabel(conflict: AgencySessionConflict): string {
  return `Leave ${conflict.campaign_name} and join here`;
}

export const SWITCH_CONFIRM_TITLE = 'Leave that station?';

/** The confirm dialog's body, before anything has been tried yet. */
export function switchConfirmMessage(conflict: AgencySessionConflict): string {
  return `This closes your session on ${conflict.campaign_name} and joins this campaign right after.`;
}

export const SWITCH_CONFIRM_ACTION = 'Leave & join here';

/**
 * Which of the three chained requests `AgentConsolePage.confirmSwitch` failed
 * at — resuming the other campaign's session (to learn its `session_id`,
 * which the conflict body never carries), leaving it, or rejoining this one.
 * Each needs a different sentence: a failure at `resume` left nothing changed,
 * one at `leave` means the agent is still on the other station exactly as
 * before, and one at `rejoin` means they have already left it and are
 * currently at NEITHER station.
 */
export type SwitchStage = 'resume' | 'leave' | 'rejoin';

/**
 * The failure sentence for whichever stage `confirmSwitch` was on, so the
 * confirm dialog can say something more useful than "Something went wrong" —
 * in particular, `rejoin` has to say the other station is already closed,
 * because that is the one outcome an agent must not be left to guess at.
 */
export function switchFailureCopy(stage: SwitchStage, campaignName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : null;
  switch (stage) {
    case 'resume':
      return detail
        ? `Couldn’t reach ${campaignName} to leave it — ${detail}`
        : `Couldn’t reach ${campaignName} to leave it. Try again.`;
    case 'leave':
      return detail
        ? `${campaignName} is still open — ${detail}`
        : `${campaignName} is still open. Try again.`;
    case 'rejoin':
      return detail
        ? `Left ${campaignName}, but couldn’t join this campaign — ${detail}`
        : `Left ${campaignName}, but couldn’t join this campaign. Try again.`;
  }
}
