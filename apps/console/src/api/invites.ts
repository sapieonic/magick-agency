import { ENDPOINTS, ORIGINATOR, ORIGINATOR_HEADER } from '../config';
import { toFetchError } from '../utils/errors';
import { captureApiError } from './error-analytics';
import { redactInviteToken } from '../analytics/redact';
import { apiFetch } from './client';
import type { SessionResponse } from '../types/auth';
import type { AgencyInvite, InviteLookup, InviteUnavailableStatus } from '../types/invite';
import type { ResendInviteResult } from '../types/team';

/**
 * The two public invite endpoints, reached with raw `fetch` rather than
 * `apiFetch`.
 *
 * ── Why not `apiFetch`, which every other module uses ──────────────────────
 * `apiFetch` treats a 401 as "the session we were holding has lapsed": it clears
 * the session clock, signs the user out of Firebase and sets
 * `window.location.href = sessionExpiredLoginUrl()`. On every other route that is
 * exactly right. Here it is destructive. `POST /invites/:token/claim` answers 401
 * for a Firebase token the server would not accept — a credential that is seconds
 * old, on a page the visitor reached from an email while signed out — and the
 * response to that must be a sentence in the card, not a full-page navigation
 * that abandons the token URL and lands the invited agent on a sign-in form for
 * an account they do not have yet.
 *
 * Both endpoints are unauthenticated, so nothing is lost by dropping the header
 * injection either; the id token travels in the BODY on the claim, which is what
 * makes the token rather than the caller's session the authority. The originator
 * header is still sent, so invite traffic stays attributable to this client.
 *
 * `toFetchError` keeps the masking contract these hand-rolled paths would
 * otherwise lose — see `utils/errors.ts` — so a masked 5xx still carries its
 * copyable request id into whatever renders the message.
 *
 * ── What dropping `apiFetch` DID cost, and what is bought back here ────────
 * `captureApiError`. Every other module reaches the `api_error` funnel through
 * `apiFetch`'s failure path for free, and these two endpoints silently did not —
 * on the very page whose funnel motivates the five `agency_invite_*` events. So
 * both call it directly, and both do it only for a failure that is NOT a modelled
 * invite outcome: an expired invitation, a revoked one, a `not_found` and a claim
 * conflict are states this flow reports with their own events and their own
 * screens, and re-reporting them as API errors would bury a genuine outage in a
 * stream of ordinary onboarding.
 *
 * The URL is redacted first. `safeAnalyticsPath` would usually reduce the token
 * segment to `:id` by entropy, but "usually" is the wrong word for a live invite
 * token — see `analytics/redact.ts`, which knows the shape rather than guessing
 * at it.
 *
 * ── The one route here that IS authenticated ───────────────────────────────
 * {@link resendInvite} goes through `apiFetch` like every other in-app call. The
 * paragraphs above are about a visitor with no session on a public page; a
 * supervisor pressing Resend has a session, and a 401 there genuinely does mean
 * theirs has lapsed and genuinely should send them to sign in again.
 */

/**
 * Thrown when the invite itself is the problem, rather than the request.
 *
 * Carries the `status` so the page can switch to that status's own screen. A
 * plain `Error` would flatten "this invitation expired last Tuesday" and "the
 * network is down" into one message, and those need opposite affordances: a
 * resend request to a supervisor versus a retry button.
 */
export class InviteUnavailableError extends Error {
  constructor(public readonly status: InviteUnavailableStatus) {
    super(`Invite unavailable: ${status}`);
    this.name = 'InviteUnavailableError';
  }
}

/**
 * The server's own conflict on the claim: the FIREBASE account being claimed with
 * already belongs to a different user row here, so binding it would break
 * `users.firebase_uid`'s unique constraint.
 *
 * Its own class rather than an {@link InviteUnavailableError}, because the
 * invitation is FINE — the server leaves it outstanding on purpose, since the remedy
 * is another account rather than another invitation. Told apart in the page so
 * the mismatch screen (and with it the only control that signs out) survives the
 * failure instead of being torn down, which is what left the visitor looping on
 * "Continue with Google" against the colliding account.
 *
 * Carries the server's message rather than composing one: it names both remedies
 * (sign in with that account directly, or ask for an invitation to that address)
 * and the server is the side that knows which of them is available.
 */
export class InviteIdentityInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteIdentityInUseError';
  }
}

/** The `status` of a parsed body, when it is one of the terminal states. */
function unavailableStatus(body: unknown): InviteUnavailableStatus | null {
  if (typeof body !== 'object' || body === null) return null;
  const status = (body as { status?: unknown }).status;
  return status === 'claimed'
    || status === 'expired'
    || status === 'revoked'
    || status === 'not_found'
    || status === 'identity_already_bound'
    ? status
    : null;
}

/** Whether the server answered the claim with its `identity_in_use` conflict. */
function isIdentityInUse(body: unknown): boolean {
  return typeof body === 'object'
    && body !== null
    && (body as { status?: unknown }).status === 'identity_in_use';
}

/** A body's `message`, when it has a usable one. */
function bodyMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/** Parse a response body, tolerating a non-JSON one rather than throwing over it. */
async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { message: res.statusText };
  }
}

/**
 * The terminal status a RESPONSE carries, from its HTTP status as well as its
 * body.
 *
 * ── A 404 is the value, whatever the body says ─────────────────────────────
 * {@link getInvite}'s contract — and the test named for it — is that a 404 is
 * answered as `{ status: 'not_found' }` rather than thrown, because a link an
 * email client wrapped across two lines is the commonest way one of these
 * arrives, it has its own screen, and its advice ("copy the whole link") is
 * something the recipient can act on alone. The implementation inspected only
 * `body.status`, so the contract held exactly as far as the server's own JSON: a 404
 * carrying `{ error: 'Not Found' }`, an empty body, or a gateway's HTML error
 * page fell through to the throw and rendered "We could not open your
 * invitation — try again", on the one failure retrying cannot fix. The server does
 * send the field today; a proxy, a CDN or an ingress in front of it need not, and
 * this is a page reached from an email on somebody else's network.
 *
 * So the HTTP status is the source of the value and the body only REFINES which
 * one it is — a 404 that names a status is taken at its word, and one that names
 * nothing is `not_found`. The cost of the trade is worth stating: a 404 caused by
 * the route being unmounted (a deploy skew, a wrong API base) now reads as a
 * missing invitation rather than as an outage, and is not reported to
 * `api_error`. That is the same trade the endpoint already made for the server's own
 * 404s, and the alternative — telling somebody with a broken link to try again —
 * is worse in the case that actually happens.
 */
function responseStatus(res: Response, body: unknown): InviteUnavailableStatus | null {
  const named = unavailableStatus(body);
  if (named) return named;
  return res.status === 404 ? 'not_found' : null;
}

/**
 * Look an invite up. Public and unauthenticated — this runs on a cold page load,
 * before the visitor has any credential at all.
 *
 * A 404 is answered as a VALUE (`{ status: 'not_found' }`) rather than thrown,
 * because it is not an error in this flow: a link an email client wrapped and
 * truncated is the single commonest way an emailed URL arrives, and it has its
 * own screen and its own advice. See {@link responseStatus} for why the HTTP
 * status decides that and not the body. Only a request that failed for some other
 * reason throws, and the caller renders that as "we could not reach us, try
 * again".
 */
export async function getInvite(token: string): Promise<InviteLookup> {
  const url = ENDPOINTS.invites.get(token);
  const res = await fetch(url, {
    headers: { [ORIGINATOR_HEADER]: ORIGINATOR },
  });
  const body = await readBody(res);

  const status = responseStatus(res, body);
  if (status) return { status };

  if (!res.ok) {
    // A modelled status returned above without reporting anything: those are
    // outcomes, and `agency_invite_viewed` already carries them. This is a real
    // failure of the endpoint.
    captureApiError(redactInviteToken(url), res);
    throw toFetchError(res, body, `Could not read that invitation (${res.status})`);
  }

  if (
    typeof body === 'object' &&
    body !== null &&
    (body as { status?: unknown }).status === 'pending' &&
    typeof (body as { invite?: unknown }).invite === 'object' &&
    (body as { invite?: unknown }).invite !== null
  ) {
    return { status: 'pending', invite: (body as { invite: AgencyInvite }).invite };
  }

  /*
    A 200 that is neither `pending` with a body nor one of the four terminal
    statuses is the server answering something this client does not model. Treated as
    unreachable rather than rendered: a half-populated invitation card — a role
    and a workspace with no address, say — is worse than the retry affordance,
    because it invites somebody to claim a membership nobody can describe.
  */
  throw new Error('That invitation could not be read. Please try again.');
}

/**
 * Claim the invite with a Firebase id token, and receive a platform session.
 *
 * The response body is EXACTLY `POST /auth/session`'s — the server's own contract,
 * not a coincidence — which is what lets `AuthContext` adopt it through the same
 * path a sign-in uses instead of growing a second session-adoption path. `is_new`
 * is always `false` here: the tenant already exists and the membership was
 * already written, and this call attaches a credential to it.
 */
export async function claimInvite(token: string, idToken: string): Promise<SessionResponse> {
  const url = ENDPOINTS.invites.claim(token);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [ORIGINATOR_HEADER]: ORIGINATOR,
    },
    body: JSON.stringify({ id_token: idToken }),
  });
  const body = await readBody(res);

  if (!res.ok) {
    /*
      A 409 (and a 404) means the invite went terminal between the lookup and the
      claim — a supervisor revoked it, it expired while the form was open, or a
      second tab claimed it first. That is a state change, not a failed request,
      so it is raised as the typed error and the page switches screens rather
      than leaving an error under a form that can no longer succeed. Read through
      {@link responseStatus}, so a bodyless 404 from something between here and
      the server is the same state change rather than a bare error under the form —
      the identical defect {@link getInvite} had, on the same token.

      `identity_already_bound` joins them: the server refuses to rebind a user row
      that already has a real account, and the honest reading of that is "you are
      already set up — sign in." See `types/invite.ts`.
    */
    const status = responseStatus(res, body);
    if (status) throw new InviteUnavailableError(status);

    /*
      `identity_in_use` is the one 409 that is NOT about the invitation: the
      account they signed in with belongs to somebody else's row here, the
      invitation is untouched, and another account still claims it. Its own type,
      so the page can keep the mismatch screen — and its sign-out button — instead
      of returning them to the two options still signed in as the colliding
      account, which is a loop.
    */
    if (isIdentityInUse(body)) {
      throw new InviteIdentityInUseError(
        bodyMessage(body)
          ?? 'That sign-in already belongs to a different account here. Sign in with it directly.',
      );
    }

    captureApiError(redactInviteToken(url), res);
    throw toFetchError(res, body, `Could not accept that invitation (${res.status})`);
  }

  return body as SessionResponse;
}

/**
 * Re-issue an invitation for a membership whose invite has not been used.
 *
 * ── Why this exists: the one-way door it closes ────────────────────────────
 * Invitations expire (seven days by default). The server revokes any outstanding
 * token and mints a fresh one on this route, and its own copy names it as THE
 * recovery path — but until this function there was no caller anywhere in the
 * product, so the dead end was guaranteed rather than hypothetical: the invite
 * lapses, the join page tells the agent "ask your supervisor to send a new one",
 * the supervisor re-invites the same address, and `POST /users/invite` answers
 * `409 User already has a membership in this context`. The only remaining move
 * was to delete the membership and start again, which loses the agent's history.
 *
 * `apiFetch`, unlike the two public functions above: this one is authenticated
 * (`user.invite`), it is called from inside the app by somebody who has a
 * session, and a 401 here really does mean their session lapsed.
 *
 * Answers the same `{ invite_email, sign_in_url }` shape `POST /users/invite`
 * does — the server's contract, so one hand-off panel can describe either.
 */
export function resendInvite(tenantId: string, membershipId: string): Promise<ResendInviteResult> {
  return apiFetch(ENDPOINTS.invites.resend, {
    method: 'POST',
    body: JSON.stringify({ membership_id: membershipId }),
  }, tenantId);
}
