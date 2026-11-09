/**
 * SEAM: voice engine (the carrier's inbound callbacks) → agency (what an inbound call MEANS)
 * (decision B11: seams are fixed files; docs/seams.md §3.5, docs/inbound.md §3).
 *
 * The voice area owns the carrier-facing surface of an inbound call: the routes under
 * `/api/v1/webhooks/plivo` (`api/routes/webhooks/plivo-inbound.ts`), their verification (the
 * credential's purpose token, the carrier's signature over the stored URL, the nonce) and the XML
 * the carrier is answered with. What the call means (which account and route it belongs to, who
 * the caller is, whether it is admitted, what they hear, the Missed row and the callback) is the
 * agency area's, reached only through this interface. `bootstrap/agency.ts` registers the
 * implementation (`agency/inbound/inbound-call-router.ts`) at start and clears it at stop.
 *
 * Until it is registered (agency not started yet, or stopped), an arriving call is answered with
 * the static fallback message and nothing is written, the same as the carrier's own fallback
 * answer URL; an ended call is acknowledged and nothing is written. Implementations never throw
 * for a call they cannot place: they answer `fallback` (a fault) or `hangup` (a refusal).
 */

/** A verified call arriving on a credential's inbound Application. */
export interface InboundCallArrival {
  credentialId: string;
  /** The credential's tenant: the call's. */
  tenantId: string;
  provider: string;
  /** The credential's status now: a call on a credential that is not `active` is answered closed (§10). */
  credentialStatus: 'active' | 'disabled' | 'invalid' | 'revoked';
  /** The carrier's own call id (Plivo's `CallUUID`). */
  carrierCallId: string;
  /** The caller, +E.164; null: withheld. */
  fromE164: string | null;
  /** The number rung, +E.164. */
  toE164: string;
}

/**
 * A fixed message the carrier speaks itself (`<Speak>`), then puts the call down: where nothing
 * of ours can play (no account to stream for), or where the route has no recording for the
 * message the call is answered with (docs/inbound.md §3.4). The voice area owns the words:
 *  - `closed`: we cannot take the call now, try again later (no promise of a callback);
 *  - `callback`: everyone is busy, we will call you back;
 *  - `busy`: all our lines are busy, try again shortly (also, in opening hours, instead of
 *    `callback` to a caller who may not be promised a callback: withheld, or on DNC).
 */
export type InboundSpokenMessage = 'closed' | 'callback' | 'busy';

/**
 * How to answer an arriving call:
 *  - `stream`: our answer XML streams the call to `streamUrl` (the bridge holds the caller);
 *  - `spoken`: a fixed message spoken by the carrier, then put down; the agency side has already
 *    ended the call and written its Missed row and callback;
 *  - `hangup`: refused (a number not linked, not the tenant's, retired, a call id that is not
 *    this credential's);
 *  - `fallback`: we could not place the call (a fault): the fixed fallback message.
 */
export type InboundAnswerDecision =
  | { kind: 'stream'; callId: string; streamUrl: string; maxDurationSeconds: number }
  | { kind: 'spoken'; message: InboundSpokenMessage }
  | { kind: 'hangup' }
  | { kind: 'fallback' };

/** How the voice area bounds an answer. */
export interface InboundAnswerOptions {
  /**
   * Aborted when the carrier has been answered without this decision (the answer's budget ran
   * out: the caller hears the fixed fallback message, "try again shortly"). From then on the
   * call is the fallback's: the agency side places nothing more (no stream, no message) and
   * leaves no follow-up, since the caller was told to ring again, not that we would call.
   */
  signal?: AbortSignal;
}

/** A verified hangup of an inbound call (the Application's hangup URL). */
export interface InboundCallHangup {
  credentialId: string;
  tenantId: string;
  provider: string;
  carrierCallId: string;
  /** The carrier's terminal status, lower-cased (`completed`, …). */
  callStatus: string;
  /** Who hung up, as the carrier names it (`Caller`, `API Request`, …), or ''. */
  hangupSource: string;
  /**
   * The carrier's duration of the call in whole seconds (Plivo's `Duration`), when it sent one:
   * what it bills, kept on the call (`carrier_seconds`, SWE-F8) because a call answered with a
   * spoken message ends on our side at the answer while the carrier goes on speaking.
   */
  durationSeconds?: number;
}

export interface InboundCallRouter {
  /** Decide and prepare an arriving call. Bounded by the caller (the carrier's answer-URL timeout; `opts.signal`). */
  answer(arrival: InboundCallArrival, opts?: InboundAnswerOptions): Promise<InboundAnswerDecision>;
  /**
   * The carrier says the call ended: settle what the agency owns of it. Returns the media leg
   * (`agency_calls.id`) the bridge must be told about, or null (no such call, or no leg).
   */
  ended(hangup: InboundCallHangup): Promise<{ legId: string | null }>;
}

const UNWIRED: InboundCallRouter = {
  async answer() {
    return { kind: 'fallback' };
  },
  async ended() {
    return { legId: null };
  },
};

let router: InboundCallRouter = UNWIRED;

export function setInboundCallRouter(next: InboundCallRouter | null): void {
  router = next ?? UNWIRED;
}

export function getInboundCallRouter(): InboundCallRouter {
  return router;
}

/** Tests only. */
export function resetInboundCallRouter(): void {
  router = UNWIRED;
}
