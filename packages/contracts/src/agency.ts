// Notes on vocabulary: "the dialer runtime" below means the private handler
// instance reached through `callCore`; "the public API layer" is the main
// Fastify app that validates, authorises and enriches requests. Both live in
// the same application.
/**
 * ─── AGENCY DIALER — FROZEN CONTRACT ────────────────────────────────────────
 *
 * Types and `as const` vocabularies only. This module has **no runtime behaviour**
 * beyond those constants, so importing it can never pull the agency engine into a
 * caller's graph.
 *
 * Frozen ahead of Phase 1 because three teams build against it in parallel:
 * the public API layer forwards these shapes, the console renders them, and the
 * tests are written against them. Changing anything here after the freeze is a contract
 * change: announce it, do not just edit it.
 *
 * Authority: the agency dialer design.
 * Where this file and the design disagree, this file is what actually ships;
 * every such divergence is called out in a comment naming the reason.
 *
 * **Phase 2 amendment (the pool).** Everything wrap-up, break, disposition, notes
 * and reconnect needs is frozen in the PHASE 2 block of `./agency/actions.ts`, plus
 * four *additive* changes to shapes frozen in Phase 1, each marked `P2:` where it
 * appears:
 *   1. `AgencyStationIntervals.deferred_hangup_ms` — new, required. The dialer runtime is the
 *      only producer of this object, so a required field is additive for every
 *      consumer; the console needs it reliably to render a reconnect countdown.
 *   2. `AgencyStationReadyFrame.active_wrapup` / `.missed_release` /
 *      `.pending_state` / `.pending_break_reason` — new, optional. The last two
 *      deliberately reuse the names and types they already carry on
 *      `AgencyStationAgentStateFrame`, so a console that renders a pending-break
 *      badge from one can render it from the other with no new vocabulary.
 *   3. `AgencyStationAgentStateFrame.pending_state` / `.pending_break_reason` — new,
 *      optional. A break requested mid-call is queued, and the console must be able
 *      to say so after a reconnect, not only from the HTTP response that queued it.
 *   4. `AgencyStationServerFrame` gains `AgencyStationWrapupFrame`. The union was
 *      already declared non-exhaustive (the bridge writes its own frames onto this
 *      socket), so a client that ignores an unknown `event` is unaffected.
 * No Phase 1 field changed type, changed meaning, or was removed.
 *
 * Vocabulary note: an **attempt** is one dial. A **session** is one agent's shift
 * on one campaign. A **station socket** is that session's long-lived WebSocket.
 * The station socket outlives every attempt on it — see
 * `WebRtcBridgeManager.createBridgedCall`.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * This file is the barrel; the declarations live in `./agency/*.ts`, one file per
 * surface, and every name stays importable from `@magick-agency/contracts/agency`.
 * The action error union `AgencyActionErrorCode` is declared in `./errors.ts`
 * with its runtime list, and re-exported here.
 */

export * from './agency/enums';
export * from './agency/session';
export * from './agency/station';
export * from './agency/actions';
export * from './agency/campaign-stats';
export * from './agency/campaign-lifecycle';
export * from './agency/performance';
export * from './agency/spine';
export type { AgencyActionErrorCode } from './errors';
