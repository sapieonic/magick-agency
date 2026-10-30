import { useCallback, useEffect, useState } from 'react';
import { returnFromSoftphone } from '../../../api/softphone';
import { trackAgencySoftphoneSwitch } from '../../../analytics/events';
import { useSoftphone, type SoftphoneState } from '../../../hooks/useSoftphone';
import { useSoftphoneAvailable } from '../../../components/agency/AgentNav';
import { refusalCopy, SOFTPHONE_REFUSAL_COPY } from '../../../utils/softphone/refusalCopy';
import { SOFTPHONE_BREAK_REASON } from '../../../types/softphone';
import type { AgencyConsoleState } from '../useAgencyConsole';
import type { AgencySessionBootstrap } from '../../../types/agency';

export interface StationSoftphone {
  /** The flag is on for the account and the caller holds `agency.softphone.dial`. */
  available: boolean;
  /** The session is on the soft phone (`break/soft_phone`): the station shows `SoftphoneView`. */
  active: boolean;
  sp: SoftphoneState;
  returning: boolean;
  /** Why Return to campaign is disabled right now, or null. */
  returnBlockedReason: string | null;
  returnFailure: string | null;
  returnToCampaign: () => void;
}

/**
 * The campaign station's soft phone (SP7, `docs/softphone.md` §4.2).
 *
 * ── When the station is "on the soft phone" ──────────────────────────────────
 * When `agent_state` says `break` with the reserved reason `soft_phone`. The one
 * gap: a station that reloads mid-switch gets `ready`, which carries the state
 * and no break reason, so `break` with an unknown reason asks the soft phone's
 * bootstrap, whose `session.on_softphone` is the server's answer for this
 * session. An ordinary break keeps the ordinary rail and its End break.
 *
 * ── The same socket, the same microphone ─────────────────────────────────────
 * `useSoftphone` reads this station's `manual_call` frames and connection; the
 * audio is the console's own (`useAgencyConsole` routes a live manual call
 * through the same `sync`), so the mic is never opened twice.
 *
 * ── Return to campaign ───────────────────────────────────────────────────────
 * Ends the soft-phone break (`POST /sessions/:id/softphone/return`). Refused
 * with `manual_call_live` while a call is live or owes its outcome — and
 * disabled here with that reason first, so the refusal is a backstop.
 */
export function useStationSoftphone({
  bootstrap,
  cons,
  tenantId,
  accountId,
  userId,
}: {
  bootstrap: AgencySessionBootstrap | null;
  cons: AgencyConsoleState;
  tenantId: string | undefined;
  accountId: string | undefined;
  userId: string | null;
}): StationSoftphone {
  const available = useSoftphoneAvailable();
  const { station, clock, audio } = cons;
  const reason = station.breakReasonCode;
  const onBreak = station.agentState === 'break';
  const candidate = available && onBreak && (reason === SOFTPHONE_BREAK_REASON || reason === null);

  const sp = useSoftphone({
    tenantId,
    accountId,
    userId,
    sessionId: bootstrap?.session_id ?? null,
    connection: station.connection,
    frameCall: station.manualCall,
    clock,
    audio,
    presetCampaignId: bootstrap?.campaign_id ?? null,
    surface: 'station',
    cueVolume: cons.cuePrefs.volume,
    enabled: candidate,
  });

  const serverSays =
    sp.bootstrap?.session?.session_id === bootstrap?.session_id && sp.bootstrap?.session?.on_softphone === true;
  const active = candidate && (reason === SOFTPHONE_BREAK_REASON || serverSays);

  const [returning, setReturning] = useState(false);
  const [returnFailure, setReturnFailure] = useState<string | null>(null);

  // A transition retires a failure that described the state before it.
  useEffect(() => {
    setReturnFailure(null);
  }, [station.agentState, station.agentStateSince]);

  const returnBlockedReason = sp.call ? SOFTPHONE_REFUSAL_COPY.manual_call_live : null;

  const returnToCampaign = useCallback(async () => {
    if (!bootstrap || returning || sp.call) return;
    setReturning(true);
    setReturnFailure(null);
    const result = await returnFromSoftphone(bootstrap.session_id, tenantId, accountId);
    setReturning(false);
    trackAgencySoftphoneSwitch({
      action: 'return',
      queued: false,
      outcome: result.ok ? 'accepted' : 'refused',
      code: result.ok ? null : result.refusal.code,
    });
    if (result.ok) return;
    if (result.refusal.code === 'manual_call_live') {
      // The server holds a call we do not show: take its copy, then say why.
      sp.reloadBootstrap();
    }
    setReturnFailure(refusalCopy(result.refusal));
  }, [bootstrap, returning, sp, tenantId, accountId]);

  return {
    available,
    active,
    sp,
    returning,
    returnBlockedReason,
    returnFailure,
    returnToCampaign: () => void returnToCampaign(),
  };
}
