import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelHelp, raiseHelp } from '../../../api/agency';
import { useLatestRef } from '../../../hooks/useLatestRef';
import type { ServerClock } from '../../../hooks/useServerClock';
import { errorCode, errorStatus } from '../../../utils/agencyErrors';
import type { UseAgencyStationResult } from '../../../hooks/useAgencyStation';
import { STATION_HELP_COPY, helpRaisable } from '../../../utils/agency/stationHelp';
import { STATION_COPY, helpAnsweredLine, helpRefusedLine } from '../../../utils/agency/stationCopy';
import type { StationHelpNotice } from '../../../utils/agencyStationReducer';
import { HelpTelemetry, answeredHelp, failedWithNoAnswer, type HelpWhere } from '../../../utils/agency/helpTelemetry';

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
 * so focus stays on the same button across the press. Cancelling is always offered, since a
 * request outlives the call it was raised on until it is answered, cancelled or lapses.
 *
 * ── Where raising is offered (BE-9) ─────────────────────────────────────────
 * With `everywhere` (the redesigned station), in every state of a joined session: the server
 * accepts a raise on Ready, on a break and offline after joining as much as on a call. An older
 * server still refuses off a call with `409 help_not_on_call`; the first such refusal narrows this
 * session back to calls and wrap-up (`everywhere` reads false from then on, and the station hides
 * the button off a call again), until the next session. Without `everywhere`, raising is offered
 * only on a call or in wrap-up (LF13, said before asking).
 *
 * ── Telemetry (LF39) ─────────────────────────────────────────────────────────
 * The events and when they fire: `utils/agency/helpTelemetry`; which request a frame counts for:
 * `helpFrameInScope` (`utils/agencyStationReducer`), which this hook feeds the agent's presses
 * (`noteHelpPress`). Every press names where it was made (`HelpWhere`: the campaign's screen, an
 * inbound call, a soft phone screen, and whether on a call as that screen shows it); the caller
 * decides, this hook never guesses. Only the request's own failure is a refusal (a 2xx with no
 * usable `help` too), never an error thrown while handling its answer. One hook per page, so its
 * memory of what was sent outlives reconnects and moves between the page's screens.
 */
export interface StationHelp {
  /** `agency_floor_assist_enabled` is on: the control is shown at all. */
  offered: boolean;
  /** Raising is offered in every state (BE-9); false once an older server refused off a call. */
  everywhere: boolean;
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
  /** The refusal of the agent's last press, in the station's words (AS15, `helpRefusedLine`). */
  refusal: string | null;
  /** The last thing worth saying out loud, with a counter so the same words are said again. */
  announcement: { text: string; seq: number } | null;
  /** Raise or cancel; `where` is where the agent pressed, and whether on a call then (telemetry only). */
  press: (where: HelpWhere) => void;
  dismiss: () => void;
}

export function useStationHelp({
  offered,
  everywhere: everywhereAsked = false,
  sessionId,
  tenantId,
  accountId,
  station,
  clock,
}: {
  offered: boolean;
  /** Offer raising in every state of the session (BE-9). */
  everywhere?: boolean;
  sessionId: string | null;
  tenantId?: string;
  accountId?: string;
  station: Pick<UseAgencyStationResult, 'agentState' | 'help' | 'helpNotice' | 'helpFrames' | 'setHelp' | 'noteHelpPress' | 'dismissHelpNotice'>;
  /** The page's server-aligned clock: when a raise was pressed and how long a request was open (telemetry). */
  clock: Pick<ServerClock, 'since' | 'now' | 'offsetMs'>;
}): StationHelp {
  const { agentState, help, helpNotice, helpFrames, setHelp, noteHelpPress, dismissHelpNotice } = station;
  const [busy, setBusy] = useState(false);
  // What the agent's last press was refused with: the press, and the server's code and status.
  const [refusalKind, setRefusalKind] = useState<HelpRefusalKind | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number } | null>(null);
  const say = useCallback((text: string) => setAnnouncement((was) => ({ text, seq: (was?.seq ?? 0) + 1 })), []);
  // Read at press time: a double press while the first is in flight sends nothing more.
  const busyRef = useRef(false);
  const helpRef = useLatestRef(help);
  const noticeRef = useLatestRef(helpNotice);

  // What was sent, per request: held for the page's life (LF39).
  const clockRef = useLatestRef(clock);
  const telemetryRef = useRef<HelpTelemetry | null>(null);
  if (telemetryRef.current === null) {
    telemetryRef.current = new HelpTelemetry((raisedAt) => clockRef.current.since(raisedAt));
  }
  const telemetry = telemetryRef.current;
  // Every frame heard since the last read, in order: frames that land in one render all count.
  const readSeqRef = useRef(0);
  useEffect(() => {
    const last = helpFrames.at(-1)?.seq ?? 0;
    for (const heard of helpFrames) {
      if (heard.seq > readSeqRef.current) telemetry.frameSeen(heard);
    }
    readSeqRef.current = last;
  }, [telemetry, helpFrames]);

  // An older server's `help_not_on_call` narrows this session back to calls (BE-9).
  const [narrowedFor, setNarrowedFor] = useState<string | null>(null);
  const everywhere = everywhereAsked && (sessionId === null || narrowedFor !== sessionId);

  // A refusal is about the state it was pressed in; a new state makes it stale.
  useEffect(() => {
    setRefusalKind(null);
  }, [agentState]);

  const open = help !== null;
  const raisable = everywhere || helpRaisable(agentState);

  const press = useCallback((where: HelpWhere) => {
    if (!offered || !sessionId || busyRef.current) return;
    const cancelling = helpRef.current !== null;
    const raisedAt = helpRef.current?.raised_at ?? null;
    if (!cancelling && !raisable) return;
    busyRef.current = true;
    setBusy(true);
    // The press, for the frames' scope (LF39): Cancel for this request, or a raise (at the press on
    // the server-aligned clock, in server time), in flight until its request settles (`finally`).
    if (cancelling && raisedAt !== null) noteHelpPress({ type: 'help_cancel_pressed', raisedAt });
    if (!cancelling) noteHelpPress({ type: 'help_raise_started', at: clockRef.current.now() + clockRef.current.offsetMs });
    setRefusalKind(null);
    /** A refused or failed press: said in the station's words (AS15), and counted once. */
    const refuse = (kind: HelpRefusalKind, noAnswer: boolean) => {
      telemetry.refused(kind.action, kind.code, kind.status, noAnswer);
      setRefusalKind(kind);
      say(helpRefusedLine(kind));
    };
    const action = cancelling ? 'cancel' : 'raise';
    const request = cancelling ? cancelHelp(sessionId, tenantId, accountId) : raiseHelp(sessionId, tenantId, accountId);
    // The request's own failure is handled apart from its answer's handling: only the request's
    // failure is a refusal, so nothing thrown below is ever counted as one.
    request
      .then(
        (answer) => {
          const help = answeredHelp(answer);
          // A 2xx with no usable `help`: the press did not go through, as far as the station can tell.
          if (help === undefined) {
            refuse({ action, code: null, status: null }, false);
            return;
          }
          // The raise's answer is the raise (once per request); a cancel's says nothing by itself.
          if (!cancelling) telemetry.raiseAnswered(help, where);
          setHelp(help);
          // A request a supervisor answered while the cancel was on its way was not cancelled: the
          // answer is what the station says (it already did), never "cancelled" after it.
          const notice = noticeRef.current;
          const answered = notice?.kind === 'answered' && notice.raised_at === raisedAt;
          if (cancelling && !answered) say(STATION_HELP_COPY.cancelledAnnouncement);
        },
        (err: unknown) => {
          if (!cancelling && errorCode(err) === 'help_not_on_call') setNarrowedFor(sessionId);
          // The station's own words, keyed on the code (AS15): what the banner shows is what is said.
          refuse({ action, code: errorCode(err), status: errorStatus(err) }, failedWithNoAnswer(err));
        },
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        // Answered, refused or failed: no longer in flight. No frame lands between the answer's
        // handling and here (a frame is a later task), and `busyRef` holds a second press till now.
        if (!cancelling) noteHelpPress({ type: 'help_raise_ended' });
      });
  }, [offered, sessionId, tenantId, accountId, raisable, helpRef, noticeRef, setHelp, noteHelpPress, say, telemetry, clockRef]);

  /*
    What the station says. While a request is open: that it is waiting, until a supervisor answers
    (`help_answered` arrives a moment before the `help_cleared` that ends it). Once it has ended:
    the notice, if there is one (answered or lapsed), until dismissed or a new request.
  */
  const answeredNow = helpNotice !== null && help !== null && helpNotice.raised_at === help.raised_at;
  const status = help !== null
    ? (answeredNow ? noticeLine(helpNotice) : STATION_HELP_COPY.open)
    : (helpNotice ? noticeLine(helpNotice) : null);

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
    everywhere,
    open,
    busy,
    blockedReason: open || raisable ? null : STATION_HELP_COPY.notOnCall,
    label: busy
      ? (open ? STATION_HELP_COPY.cancelling : STATION_HELP_COPY.raising)
      : (open ? STATION_HELP_COPY.cancel : STATION_HELP_COPY.raise),
    status,
    dismissible: help === null && helpNotice !== null,
    refusal: refusalKind ? helpRefusedLine(refusalKind) : null,
    announcement,
    press,
    dismiss: dismissHelpNotice,
  };
}

/** What the agent's last press was refused with: the press, and the server's code and status. */
type HelpRefusalKind = { action: 'raise' | 'cancel'; code: string | null; status: number | null };

/** What became of a request, in the words its banner shows (AS15): who answered and how, or that it lapsed. */
function noticeLine(notice: StationHelpNotice): string {
  return notice.kind === 'expired' ? STATION_COPY.helpExpired : helpAnsweredLine(notice.by_name, notice.how);
}
