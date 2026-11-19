import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelHelp, raiseHelp } from '../../../api/agency';
import { useLatestRef } from '../../../hooks/useLatestRef';
import type { UseAgencyStationResult } from '../../../hooks/useAgencyStation';
import {
  STATION_HELP_COPY,
  helpNoticeText,
  helpRaisable,
  helpRefusalText,
} from '../../../utils/agency/stationHelp';

/**
 * Need help on the agent's station (LF4, LF13, LF15, LF24): the raise and the cancel, and what
 * the station says about the request.
 *
 * The request on screen is the station's (`station.help`): this hook writes the raise's and the
 * cancel's answers into it (`setHelp`), and the frames move it from there (`help_answered`,
 * `help_cleared`, `ready.help`), so a reload or a reconnect shows an open request again and a
 * late frame about an earlier request never clears a newer one.
 *
 * One control: it raises while nothing is open and cancels while one is (its label says which),
 * so focus stays on the same button across the press. Raising is offered only on a call or in
 * wrap-up (the server's `help_not_on_call` rule, said before asking); cancelling always, since a
 * request outlives the call it was raised on until it is answered, cancelled or lapses.
 */
export interface StationHelp {
  /** `agency_floor_assist_enabled` is on: the control is shown at all. */
  offered: boolean;
  /** A request is open. */
  open: boolean;
  /** A raise or a cancel is in flight. */
  busy: boolean;
  /** Why pressing does nothing now (not on a call, nothing open), or null when it acts. */
  blockedReason: string | null;
  /** The control's label: the action it takes. */
  label: string;
  /** What the station says about the request: open, answered, lapsed. Null when nothing. */
  status: string | null;
  /** `status` is a notice about a request that ended, which the agent may dismiss. */
  dismissible: boolean;
  /** The refusal of the agent's last press, stated. */
  refusal: string | null;
  /** The last thing worth saying out loud, with a counter so the same words are said again. */
  announcement: { text: string; seq: number } | null;
  press: () => void;
  dismiss: () => void;
}

export function useStationHelp({
  offered,
  sessionId,
  tenantId,
  accountId,
  station,
}: {
  offered: boolean;
  sessionId: string | null;
  tenantId?: string;
  accountId?: string;
  station: Pick<UseAgencyStationResult, 'agentState' | 'help' | 'helpNotice' | 'setHelp' | 'dismissHelpNotice'>;
}): StationHelp {
  const { agentState, help, helpNotice, setHelp, dismissHelpNotice } = station;
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number } | null>(null);
  const say = useCallback((text: string) => setAnnouncement((was) => ({ text, seq: (was?.seq ?? 0) + 1 })), []);
  // Read at press time: a double press while the first is in flight sends nothing more.
  const busyRef = useRef(false);
  const openRef = useLatestRef(help !== null);

  // A refusal is about the state it was pressed in; a new state makes it stale.
  useEffect(() => {
    setRefusal(null);
  }, [agentState]);

  const open = help !== null;
  const raisable = helpRaisable(agentState);

  const press = useCallback(() => {
    if (!offered || !sessionId || busyRef.current) return;
    const cancelling = openRef.current;
    if (!cancelling && !helpRaisable(agentState)) return;
    busyRef.current = true;
    setBusy(true);
    setRefusal(null);
    const request = cancelling ? cancelHelp(sessionId, tenantId, accountId) : raiseHelp(sessionId, tenantId, accountId);
    request
      .then((answer) => {
        setHelp(answer.help);
        if (cancelling) say(STATION_HELP_COPY.cancelledAnnouncement);
      })
      .catch((err: unknown) => {
        const text = helpRefusalText(err, cancelling ? 'cancel' : 'raise');
        setRefusal(text);
        say(text);
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [offered, sessionId, tenantId, accountId, agentState, openRef, setHelp, say]);

  /*
    What the station says. While a request is open: that it is waiting, until a supervisor answers
    (`help_answered` arrives a moment before the `help_cleared` that ends it). Once it has ended:
    the notice, if there is one (answered or lapsed), until dismissed or a new request.
  */
  const answeredNow = helpNotice !== null && help !== null && helpNotice.raised_at === help.raised_at;
  const status = help !== null
    ? (answeredNow ? helpNoticeText(helpNotice) : STATION_HELP_COPY.open)
    : (helpNotice ? helpNoticeText(helpNotice) : null);

  // Said out loud when it changes: the open request (the direct result of the press), the answer,
  // the lapse. A request that ends silently (cancelled, the session ended) says nothing here.
  const lastSaid = useRef<string | null>(null);
  useEffect(() => {
    if (!offered) return;
    if (status !== null && status !== lastSaid.current) {
      say(status === STATION_HELP_COPY.open ? STATION_HELP_COPY.raisedAnnouncement : status);
    }
    lastSaid.current = status;
  }, [offered, status, say]);

  return {
    offered,
    open,
    busy,
    blockedReason: open || raisable ? null : STATION_HELP_COPY.notOnCall,
    label: busy
      ? (open ? STATION_HELP_COPY.cancelling : STATION_HELP_COPY.raising)
      : (open ? STATION_HELP_COPY.cancel : STATION_HELP_COPY.raise),
    status,
    dismissible: help === null && helpNotice !== null,
    refusal,
    announcement,
    press,
    dismiss: dismissHelpNotice,
  };
}
