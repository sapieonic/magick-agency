import { useEffect, useMemo, useRef } from 'react';
import { getMyStats } from '../../../api/agencyStats';
import { useDailyRead } from '../../../hooks/useDailyRead';
import type { AgencyAgentState } from '../../../types/agency';

/**
 * My day on Ready, No calls right now and Finish work (spec 02, 11; backend plan BE-0).
 *
 * Phase 0 reads today's `GET /proxy/agency/my-stats` for this campaign, from the agent's local
 * midnight, and shows calls (connected calls, AS6) and talk time. It is read again each time the
 * agent comes back to Ready, so the count moves after every saved call, and once a minute besides.
 *
 * ── Where new data slots in ──────────────────────────────────────────────────
 * `target` (AS6, BE-2) and `willPay` (AS7, BE-1) are null today, and a null tile is not shown.
 * When BE-1's `GET /proxy/agency/my-day` lands, its answer fills the same {@link MyDay} and
 * this read goes.
 */
export interface MyDay {
  /** Connected calls today (AS6), or null when not known. */
  calls: number | null;
  /** The campaign's daily target in connected calls (AS6, BE-2); null until the server sends it. */
  target: number | null;
  /** Talk time today, in seconds. */
  talkSeconds: number | null;
  /** Outcomes today that recorded a pay date (AS7, BE-1); null until the server sends it. */
  willPay: number | null;
}

export function useMyDay({
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
}): MyDay | null {
  const { state, reload } = useDailyRead({
    tenantId,
    accountId,
    enabled: enabled && campaignId !== null,
    // The station is the agent's own; a refusal (no permission) stops asking rather than retrying.
    stopOnRefusal: true,
    read: async (window, t, a) => {
      if (!campaignId) return null;
      const stats = await getMyStats({ ...window, bucket: 'day', campaign_id: campaignId }, t, a);
      return { connected: stats.totals.connected, talkSeconds: stats.totals.talk_seconds };
    },
  });

  // Back on Ready after a call: read again, so the count includes the call just saved.
  const was = useRef(agentState);
  useEffect(() => {
    if (agentState === 'available' && was.current !== 'available' && was.current !== 'offline') reload();
    was.current = agentState;
  }, [agentState, reload]);

  return useMemo<MyDay | null>(() => {
    if (state.status !== 'ready') return null;
    return { calls: state.value.connected, target: null, talkSeconds: state.value.talkSeconds, willPay: null };
  }, [state]);
}
