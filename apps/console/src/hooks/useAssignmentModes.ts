import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyAssignmentMode } from '@magick-agency/contracts/agency';
import { getAgencyCampaign } from '../api/agencyCampaigns';
import { useMountedRef } from './useMountedRef';

/**
 * Each campaign's assignment mode, for the campaigns whose late-callbacks row could offer "Give to
 * free agents" (LF7, LF30: never on `pool`). The board does not carry the mode, so it is read from
 * the campaign (`GET /campaigns/:id`) once per campaign and status: a mode changes only while a
 * campaign is paused, so a status change reads it again. Only the campaigns given are read (those
 * with overdue callbacks whose owner is away, usually none), never on the 5 s poll.
 *
 * A failed read leaves the mode unknown (nothing offered) until the campaign's status changes or
 * the page is opened again. {@link markPool} records a `409 late_callbacks_pool_mode` the server
 * answered, so the action goes at once.
 */
export function useAssignmentModes(
  campaigns: ReadonlyArray<{ id: string; status: string }>,
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): { modes: Readonly<Record<string, AgencyAssignmentMode>>; markPool: (campaignId: string) => void } {
  const [modes, setModes] = useState<Readonly<Record<string, AgencyAssignmentMode>>>({});
  // `id:status` already asked for, so a poll asks for nothing new.
  const asked = useRef(new Set<string>());
  const mounted = useMountedRef();
  const signature = campaigns.map((c) => `${c.id}:${c.status}`).sort().join(',');

  useEffect(() => {
    if (!enabled || !tenantId || !accountId || signature === '') return;
    for (const key of signature.split(',')) {
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      const id = key.slice(0, key.lastIndexOf(':'));
      getAgencyCampaign(id, tenantId, accountId)
        .then((campaign) => {
          const mode = campaign?.assignment_mode ?? 'pool';
          if (mounted.current) setModes((current) => (current[id] === mode ? current : { ...current, [id]: mode }));
        })
        .catch(() => {
          // Unknown: nothing offered. Asked again when the status changes.
        });
    }
  }, [signature, enabled, tenantId, accountId, mounted]);

  const markPool = useCallback((campaignId: string) => {
    setModes((current) => (current[campaignId] === 'pool' ? current : { ...current, [campaignId]: 'pool' }));
  }, []);

  return { modes, markPool };
}
