import { useEffect, useMemo, useRef } from 'react';
import { listMyContacts } from '../../../api/agencyAssignment';
import { usePolledRead } from '../../../hooks/usePolledRead';
import type { AgencyAgentState } from '../../../types/agency';
import type { AgencyMyContact } from '@magick-agency/contracts/api/agency/assignment';

/**
 * My call-later list on Ready (spec 02, 02b) and the count on Start of day.
 *
 * Phase 0 (backend plan BE-0) reads `GET /proxy/agency/my-contacts?bucket=callback`, which the
 * server serves only on a campaign that assigns contacts (`strict` / `preferred`) with
 * `agency_contact_assignment_enabled` on: the caller passes `enabled` false everywhere else and the
 * list is not shown. Only today's call-laters are listed, earliest first.
 *
 * ── Where new data slots in ──────────────────────────────────────────────────
 * BE-1's my-day read carries the agent's own call-laters on every campaign (with the booker from
 * BE-3); its rows fill the same {@link CallLaterRow} and `comesToMe` comes from the server's
 * `comes_to_me` (AS8) instead of the assignment mode.
 */
export interface CallLaterRow {
  id: string;
  /** Epoch ms when it falls due. */
  dueAt: number;
  /** What the agent knows the customer by: the first hero column, else the phone. */
  name: string;
}

export interface MyCallLaters {
  rows: CallLaterRow[];
  /** Whether these calls come back to this agent (AS8: the routing decides, as today). */
  comesToMe: boolean;
}

export const CALL_LATER_POLL_MS = 60_000;
const LIST_LIMIT = 50;

export function callLaterRowsFor(contacts: readonly AgencyMyContact[], now: Date): CallLaterRow[] {
  const today = now.toDateString();
  return contacts
    .map((c) => ({ id: c.id, dueAt: Date.parse(c.next_attempt_at), name: c.hero.find((h) => h.value.trim())?.value.trim() ?? c.phone_e164 }))
    .filter((r) => Number.isFinite(r.dueAt) && new Date(r.dueAt).toDateString() === today)
    .sort((a, b) => a.dueAt - b.dueAt);
}

export function useMyCallLaters({
  campaignId,
  tenantId,
  accountId,
  agentState,
  enabled,
}: {
  campaignId: string | null;
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  agentState: AgencyAgentState;
  enabled: boolean;
}): MyCallLaters | null {
  const { state, reload } = usePolledRead({
    tenantId,
    accountId,
    enabled: enabled && campaignId !== null,
    stopOnRefusal: true,
    periodMs: CALL_LATER_POLL_MS,
    turnOfDay: true,
    read: async (t, a, now) => {
      const page = await listMyContacts({ campaign_id: campaignId!, bucket: ['callback'], limit: LIST_LIMIT }, t, a);
      return callLaterRowsFor(page.rows, now);
    },
  });

  // A call-later booked or made on the last call changes the list: read again back on Ready.
  const was = useRef(agentState);
  useEffect(() => {
    if (agentState === 'available' && was.current !== 'available' && was.current !== 'offline') reload();
    was.current = agentState;
  }, [agentState, reload]);

  return useMemo(() => (state.status === 'ready' ? { rows: state.value, comesToMe: true } : null), [state]);
}
