import { useCallback, useEffect, useState } from 'react';
import { mintStationToken } from '../../../api/agency';
import {
  getSoftphoneBootstrap,
  openSoftphoneSession,
  type SoftphoneSessionOnCampaignRefusal,
  type SoftphoneSessionOnSoftphoneRefusal,
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
   * Off here, and the agent's soft-phone session is in ANOTHER account of the
   * tenant (`sessionAccountId`): one live session per agent per tenant, so this
   * account cannot open one, and the server rehydrates only a session in the
   * account it is asked for. The page can only close it — `leave` with the
   * session's own account — and say who can save an outcome its call still owes
   * (`call`, read from that account's bootstrap; null when there is none or the
   * read failed).
   */
  | { status: 'off_stranded'; sessionId: string; sessionAccountId: string; call: AgencyManualCall | null }
  /**
   * 409 `session_on_campaign`: the agent is live on a campaign, in this account or
   * a sibling one (`refusal.account_id`); the remedy is switching that session (§4.2).
   */
  | { status: 'on_campaign'; refusal: SoftphoneSessionOnCampaignRefusal }
  /**
   * 409 `session_on_softphone`: the soft phone is on here, and the agent's
   * soft-phone session is in ANOTHER account of the tenant (`refusal.account_id`),
   * which the server never rehydrates into this one (every route on it is scoped to
   * its account). The page closes it there, with that account, and opens one here.
   */
  | { status: 'softphone_elsewhere'; refusal: SoftphoneSessionOnSoftphoneRefusal }
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
 * With the flag on, a soft-phone session in a sibling account of the tenant is
 * not rehydrated either: the server refuses it `session_on_softphone`, naming its
 * account (`softphone_elsewhere`), as it refuses a live campaign session
 * `session_on_campaign` (`on_campaign`).
 *
 * ── With the soft phone turned off (`startAllowed: false`, or a `softphone_disabled`
 *    answer from a flag map gone stale) ──────────────────────────────────────────
 * Nothing new is opened: the bootstrap is read first, and only a soft-phone
 * session that already exists is asked for. The server rehydrates it with the
 * flag off (`rehydrate_only`, docs/softphone.md §6) when it is in THIS account,
 * into finish mode, so a reload mid-call still reaches the call. No session is
 * `off`. The one session the server will not rehydrate is one in a sibling
 * account of the tenant (the bootstrap names the agent's live session tenant-wide,
 * with its `account_id`): that is `off_stranded`, and it is decided from the
 * bootstrap without asking.
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
    /** What the soft phone holds for the caller in `account`, or null when even that is refused. */
    const probe = (account: string): Promise<AgencySoftphoneBootstrap | null> =>
      getSoftphoneBootstrap(tenantId, account).catch(() => null);
    const holdsSession = (phone: AgencySoftphoneBootstrap | null) =>
      phone?.session?.kind === 'softphone' ? phone.session : null;
    /**
     * The flag is off here: the caller's soft-phone session in this account is
     * rehydrated (`open`); one in a sibling account cannot be (`stranded`), and
     * its call is read where it lives; none is `off`.
     */
    const offHere = async (): Promise<
      | { kind: 'open' }
      | { kind: 'off' }
      | { kind: 'stranded'; sessionId: string; sessionAccountId: string; call: AgencyManualCall | null }
    > => {
      const held = holdsSession(await probe(accountId));
      if (!held) return { kind: 'off' };
      if (held.account_id === accountId) return { kind: 'open' };
      const there = await probe(held.account_id);
      return { kind: 'stranded', sessionId: held.session_id, sessionAccountId: held.account_id, call: there?.call ?? null };
    };

    coalesceJoin(key, async () => {
      if (!startAllowed) {
        const here = await offHere();
        if (here.kind !== 'open') return { off: true as const, here };
      }
      return { off: false as const, result: await openSoftphoneSession(tenantId, accountId) };
    })
      .then(async (outcome) => {
        if (cancelled) return;
        const settleOff = (here: Awaited<ReturnType<typeof offHere>>) => {
          if (here.kind === 'stranded') {
            setState({ status: 'off_stranded', sessionId: here.sessionId, sessionAccountId: here.sessionAccountId, call: here.call });
          } else {
            // `open` here means the session left between the read and the refusal.
            setState({ status: 'off' });
          }
        };
        if (outcome.off) {
          settleOff(outcome.here);
          return;
        }
        const result = outcome.result;
        if (!result.ok) {
          if (result.refusal.code === 'session_on_campaign') {
            setState({ status: 'on_campaign', refusal: result.refusal });
          } else if (result.refusal.code === 'session_on_softphone') {
            setState({ status: 'softphone_elsewhere', refusal: result.refusal });
          } else if (result.refusal.code === 'softphone_disabled') {
            // A flag map gone stale (on here, off on the server).
            const here = await offHere();
            if (cancelled) return;
            settleOff(here);
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
