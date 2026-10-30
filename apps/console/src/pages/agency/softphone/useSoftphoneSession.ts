import { useCallback, useEffect, useState } from 'react';
import { mintStationToken } from '../../../api/agency';
import {
  openSoftphoneSession,
  type SoftphoneSessionOnCampaignRefusal,
} from '../../../api/softphone';
import { coalesceJoin } from '../../../utils/agencyLiveSession';
import { refusalCopy } from '../../../utils/softphone/refusalCopy';
import type { StationSocketBootstrap } from '../../../hooks/agencyStation/types';
import type { AgencySessionBootstrap } from '../../../types/agency';
import type { AgencySoftphoneSessionResponse } from '../../../types/softphone';

export type SoftphoneSessionState =
  | { status: 'loading' }
  | { status: 'ready'; session: AgencySoftphoneSessionResponse; socket: StationSocketBootstrap }
  /** 409 `session_on_campaign`: the agent is live on a campaign; the remedy is switching that session (§4.2). */
  | { status: 'on_campaign'; refusal: SoftphoneSessionOnCampaignRefusal }
  | { status: 'error'; message: string };

/** Whether an upgrade URL already carries its single-use token. */
export function urlCarriesToken(url: string): boolean {
  return /[?&]token=[^&]+/.test(url);
}

/**
 * Open (or rehydrate) the caller's soft-phone session, and make sure its station
 * socket has an upgrade token to connect with.
 *
 * `POST /proxy/agency/softphone/sessions` answers the socket fields the campaign
 * bootstrap does, token appended (`AgencySoftphoneSessionResponse`). If a server
 * answers without one, a token is minted for the session
 * (`POST /proxy/agency/sessions/:id/station-token`) before the first connect,
 * rather than spending the first connect on a refusal; every reconnect after
 * that mints its own, inside `useAgencyStation`.
 *
 * Coalesced like the campaign join, so a StrictMode double-mount (or two tabs
 * racing in one page load) opens one session, not two.
 */
export function useSoftphoneSession({
  tenantId,
  accountId,
  enabled,
}: {
  tenantId: string | null;
  accountId: string | null;
  enabled: boolean;
}): { state: SoftphoneSessionState; retry: () => void } {
  const [state, setState] = useState<SoftphoneSessionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !tenantId || !accountId) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    const key = `softphone:${tenantId}:${accountId}:${attempt}`;
    coalesceJoin(key, () => openSoftphoneSession(tenantId, accountId))
      .then(async (result) => {
        if (cancelled) return;
        if (!result.ok) {
          if (result.refusal.code === 'session_on_campaign') {
            setState({ status: 'on_campaign', refusal: result.refusal });
          } else {
            setState({ status: 'error', message: refusalCopy(result.refusal) });
          }
          return;
        }
        const session = result.value;
        let url = session.station_ws_url;
        if (!urlCarriesToken(url)) {
          try {
            url = (await mintStationToken(session.session_id, tenantId, accountId)).station_ws_url;
          } catch {
            // The socket's own retry mints again; connecting with what we have
            // costs one refusal, not the session.
          }
        }
        if (cancelled) return;
        setState({
          status: 'ready',
          session,
          socket: {
            session_id: session.session_id,
            station_ws_url: url,
            intervals: session.intervals as AgencySessionBootstrap['intervals'],
            campaign_id: null,
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'We couldn’t open the soft phone.' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, tenantId, accountId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
