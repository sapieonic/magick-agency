import { useCallback, useEffect, useState } from 'react';
import { mintStationToken } from '../../../api/agency';
import {
  getSoftphoneBootstrap,
  openSoftphoneSession,
  type SoftphoneSessionOnCampaignRefusal,
} from '../../../api/softphone';
import { coalesceJoin } from '../../../utils/agencyLiveSession';
import { refusalCopy } from '../../../utils/softphone/refusalCopy';
import type { StationSocketBootstrap } from '../../../hooks/agencyStation/types';
import type { AgencySessionBootstrap } from '../../../types/agency';
import type { AgencyManualCall, AgencySoftphoneBootstrap, AgencySoftphoneSessionResponse } from '../../../types/softphone';

export type SoftphoneSessionState =
  | { status: 'loading' }
  | {
      status: 'ready';
      session: AgencySoftphoneSessionResponse;
      socket: StationSocketBootstrap;
      /** False when the soft phone is off for the account: the page is in finish mode. */
      startAllowed: boolean;
    }
  /** The soft phone is off for the account and the agent has nothing on it to finish. */
  | { status: 'off' }
  /**
   * Off, and the agent still has a soft-phone session (and maybe a call) the
   * server will not reopen: the page can only close it, and say who can save
   * an outcome it still owes.
   */
  | { status: 'off_stranded'; sessionId: string; call: AgencyManualCall | null }
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
 *
 * ── With the soft phone turned off (`startAllowed: false`, or a `softphone_disabled`
 *    answer from a flag map gone stale) ──────────────────────────────────────────
 * Nothing new is opened: the bootstrap is read first, and only a soft-phone
 * session that already exists is rehydrated, into finish mode, so a reload
 * mid-call still reaches the call. No session there is `off`; a session the
 * server will not rehydrate is `off_stranded`.
 */
export function useSoftphoneSession({
  tenantId,
  accountId,
  enabled,
  startAllowed = true,
}: {
  tenantId: string | null;
  accountId: string | null;
  enabled: boolean;
  /** The flag map says the soft phone is on for the account. */
  startAllowed?: boolean;
}): { state: SoftphoneSessionState; retry: () => void } {
  const [state, setState] = useState<SoftphoneSessionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !tenantId || !accountId) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    const key = `softphone:${tenantId}:${accountId}:${attempt}:${startAllowed ? 'open' : 'resume'}`;
    /** What the soft phone holds for the caller, or null when even that is refused. */
    const probe = (): Promise<AgencySoftphoneBootstrap | null> =>
      getSoftphoneBootstrap(tenantId, accountId).catch(() => null);
    const holdsSession = (phone: AgencySoftphoneBootstrap | null) =>
      phone?.session?.kind === 'softphone' ? phone.session.session_id : null;

    coalesceJoin(key, async () => {
      if (!startAllowed) {
        const phone = await probe();
        if (!holdsSession(phone)) return { off: true as const, phone };
      }
      return { off: false as const, result: await openSoftphoneSession(tenantId, accountId) };
    })
      .then(async (outcome) => {
        if (cancelled) return;
        if (outcome.off) {
          setState({ status: 'off' });
          return;
        }
        const result = outcome.result;
        if (!result.ok) {
          if (result.refusal.code === 'session_on_campaign') {
            setState({ status: 'on_campaign', refusal: result.refusal });
          } else if (result.refusal.code === 'softphone_disabled') {
            const phone = await probe();
            if (cancelled) return;
            const sessionId = holdsSession(phone);
            setState(sessionId ? { status: 'off_stranded', sessionId, call: phone?.call ?? null } : { status: 'off' });
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
          startAllowed,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'We couldn’t open the soft phone.' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, tenantId, accountId, attempt, startAllowed]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
