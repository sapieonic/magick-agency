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
 * How to answer an arriving call:
 *  - `stream`: our answer XML streams the call to `streamUrl` (the bridge holds the caller);
 *  - `closed`: the fixed closed message, spoken by the carrier, then put down (a call with no
 *    account to stream for: the tenant default, §8.3). Its Missed row is written;
 *  - `hangup`: refused (a number not linked, not the tenant's, retired);
 *  - `fallback`: we could not place the call (a fault): the fixed fallback message.
 */
export type InboundAnswerDecision =
  | { kind: 'stream'; callId: string; streamUrl: string; maxDurationSeconds: number }
  | { kind: 'closed' }
  | { kind: 'hangup' }
  | { kind: 'fallback' };

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
}

export interface InboundCallRouter {
  /** Decide and prepare an arriving call. Bounded by the caller (the carrier's answer-URL timeout). */
  answer(arrival: InboundCallArrival): Promise<InboundAnswerDecision>;
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
