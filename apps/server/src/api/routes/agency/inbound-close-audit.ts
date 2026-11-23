/**
 * What a supervisor's force-available (`POST /sessions/:id/force-available`, `sessions.ts`) adds to
 * its answer when it closed an inbound call whose outcome the agent owed (docs/inbound.md §6,
 * `InboundCallService.closeOwedForSupervisor`): the facts the public layer's
 * `agency_inbound_call.closed` row needs. A key on the answer, under
 * {@link INBOUND_CLOSE_AUDIT_KEY}, present only on the answer that closed one; the public layer
 * always takes it off before sending ({@link takeInboundCloseAudit}), as it does the soft phone's
 * exit facts (`softphone-answer.ts`).
 */
export interface InboundCloseAudit {
  inbound_call_id: string;
  /**
   * The campaign the call is filed under (its contact's, else its route's campaign for unknown
   * callers, `docs/call-log.md` §5), else the matched one: the audit row's `campaign_id`, which
   * puts the row on that campaign's History.
   */
  campaign_id: string | null;
}

import { takeAuditMarker } from '../helpers/audit-marker.js';

export const INBOUND_CLOSE_AUDIT_KEY = 'inbound_closed';

/** Remove the close facts from an internal answer (mutating it) and return them, or null. */
export function takeInboundCloseAudit(body: unknown): InboundCloseAudit | null {
  const audit = takeAuditMarker<InboundCloseAudit>(body, INBOUND_CLOSE_AUDIT_KEY);
  return audit && typeof audit === 'object' && typeof audit.inbound_call_id === 'string' ? audit : null;
}
