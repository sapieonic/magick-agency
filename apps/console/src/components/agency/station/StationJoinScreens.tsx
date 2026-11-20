import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AgencySessionConflict } from '../../../types/agency';
import { conflictIsMidCall } from '../../../utils/agencyJoinConflict';
import { DOING_WORDS, STATION_COPY } from '../../../utils/agency/stationCopy';
import { agentLandingPath } from '../../../utils/agencyStationExit';
import { stationEscapePath } from '../StationEscape';
import { StationFrame, type FrameView } from './StationFrame';
import { StationDialog } from './StationScreens';
import styles from './Station.module.css';

/**
 * The screens before work opens (ruling 2: one look across the station): the join that failed,
 * the agent still working on another list (with its one-click switch), and the soft phone holding
 * the agent's one session. Each is the station's frame: the band says what happened, the body
 * says why, the remedy is the main button bottom right, and the way off is bottom left.
 */

export interface Who {
  agentName: string;
  brandMark: string;
}

/** A screen before the station's work opens: the band says what, the card why, the remedy bottom right. */
export function JoinFrame({
  who,
  view,
  testId,
  children,
  footLeft,
  footRight,
}: {
  who: Who;
  view: FrameView;
  testId: string;
  children: ReactNode;
  footLeft: ReactNode;
  footRight?: ReactNode;
}) {
  return (
    <StationFrame
      view={view}
      agentName={who.agentName}
      workName={null}
      brandMark={who.brandMark}
      bodyClassName={styles.bodyCenter}
      footLeft={footLeft}
      footRight={footRight}
    >
      <section className={`${styles.card} ${styles.cardNarrow}`} role="alert" data-testid={testId}>
        {children}
      </section>
    </StationFrame>
  );
}

/** The way off a screen before work opens: back to the campaign, or to the agent's home screen. */
export function EscapeLink({ toCampaign, campaignId }: { toCampaign: boolean; campaignId: string }) {
  return (
    <Link className={`${styles.btn} ${styles.btnQuiet}`} to={stationEscapePath(toCampaign, campaignId)} data-testid="station-escape">
      {toCampaign ? STATION_COPY.goBack : STATION_COPY.backHome}
    </Link>
  );
}

/** The join failed for a reason with no remedy here: why, and the way off. */
export function StationFatal({
  who,
  message,
  toCampaign,
  campaignId,
}: {
  who: Who;
  message: string;
  toCampaign: boolean;
  campaignId: string;
}) {
  return (
    <JoinFrame
      who={who}
      view={{ screen: 'join_failed', tone: 'problem', icon: 'warning', title: STATION_COPY.joinFailedTitle, subtitle: STATION_COPY.joinFailedSubtitle }}
      testId="station-fatal"
      footLeft={<EscapeLink toCampaign={toCampaign} campaignId={campaignId} />}
    >
      <p className={styles.fatalLine}>{message}</p>
    </JoinFrame>
  );
}

/**
 * The agent's one live session is on another list (`409 session_on_other_campaign`). Off a call
 * there, the main button leaves it and starts here (`useStationJoin`'s switch, behind a question);
 * mid-call, only the agent may end that call, so the way is to open the other list.
 */
export function JoinConflictScreen({
  who,
  conflict,
  toCampaign,
  campaignId,
  confirming,
  switching,
  switchFailure,
  onBeginSwitch,
  onConfirmSwitch,
  onCancelSwitch,
}: {
  who: Who;
  conflict: AgencySessionConflict;
  toCampaign: boolean;
  campaignId: string;
  confirming: boolean;
  switching: boolean;
  switchFailure: string | null;
  onBeginSwitch: () => void;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}) {
  const name = conflict.campaign_name;
  const midCall = conflictIsMidCall(conflict.state);
  const openOther = (
    <Link
      className={midCall ? `${styles.btn} ${styles.btnBig} ${styles.btnGo}` : `${styles.btn} ${styles.btnQuiet}`}
      to={`/station?campaign=${encodeURIComponent(conflict.campaign_id)}`}
    >
      {STATION_COPY.otherWorkOpen(name)}
    </Link>
  );
  return (
    <>
      <JoinFrame
        who={who}
        view={{ screen: 'other_work', tone: 'quiet', icon: 'device', title: STATION_COPY.otherWorkTitle, subtitle: STATION_COPY.otherWorkSubtitle }}
        testId="join-conflict"
        footLeft={<><EscapeLink toCampaign={toCampaign} campaignId={campaignId} />{midCall ? null : openOther}</>}
        footRight={midCall ? openOther : (
          <button type="button" className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`} onClick={onBeginSwitch} data-testid="switch-station">
            {STATION_COPY.otherWorkSwitch(name)}
          </button>
        )}
      >
        <p className={styles.fatalLine}>{STATION_COPY.otherWorkDoing(name, DOING_WORDS[conflict.state])}</p>
        <p className={styles.fatalLine}>{midCall ? STATION_COPY.otherWorkMidCall(name) : STATION_COPY.otherWorkLeaveFirst(name)}</p>
      </JoinFrame>
      <StationDialog open={confirming} onClose={() => !switching && onCancelSwitch()} title={STATION_COPY.otherWorkSwitchTitle(name)} small testId="switch-confirm">
        <p>{switchFailure ?? STATION_COPY.otherWorkSwitchBody(name)}</p>
        <div className={styles.dialogFoot}>
          <button type="button" className={`${styles.btn} ${styles.btnQuiet}`} onClick={onCancelSwitch} aria-disabled={switching || undefined}>
            {STATION_COPY.otherWorkSwitchNo}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`}
            aria-disabled={switching || undefined}
            onClick={() => !switching && onConfirmSwitch()}
          >
            {switching ? STATION_COPY.otherWorkSwitching : STATION_COPY.otherWorkSwitchYes}
          </button>
        </div>
      </StationDialog>
    </>
  );
}

/**
 * The join refused with `session_on_softphone`: the agent's one live session is the soft phone.
 * The remedy is one press (close it and start here); a soft-phone call not finished is the agent's
 * to end there, so then the way is to open the soft phone.
 */
export function SoftphoneJoinScreen({
  who,
  closing,
  failure,
  callPending,
  onCloseAndJoin,
}: {
  who: Who;
  closing: boolean;
  failure: string | null;
  callPending: boolean;
  onCloseAndJoin: () => void;
}) {
  // The button the agent pressed is replaced by the reason: focus goes to what they can do about it.
  const openRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (callPending) openRef.current?.focus();
  }, [callPending]);
  const open = (
    <Link
      ref={openRef}
      className={callPending ? `${styles.btn} ${styles.btnBig} ${styles.btnGo}` : `${styles.btn} ${styles.btnQuiet}`}
      to="/dialer/phone"
      data-testid="join-open-softphone"
    >
      {STATION_COPY.openSoftphone}
    </Link>
  );
  return (
    <JoinFrame
      who={who}
      view={{ screen: 'on_softphone', tone: 'quiet', icon: 'phone', title: STATION_COPY.softphoneJoinTitle, subtitle: STATION_COPY.softphoneJoinSubtitle }}
      testId="join-on-softphone"
      footLeft={<><Link className={`${styles.btn} ${styles.btnQuiet}`} to={agentLandingPath('refused')}>{STATION_COPY.backHome}</Link>{callPending ? null : open}</>}
      footRight={callPending ? open : (
        <button
          type="button"
          className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`}
          onClick={() => !closing && onCloseAndJoin()}
          aria-disabled={closing || undefined}
          aria-busy={closing || undefined}
          data-testid="join-close-softphone"
        >
          {closing ? STATION_COPY.softphoneClosing : STATION_COPY.softphoneCloseAndStart}
        </button>
      )}
    >
      <p className={styles.fatalLine}>{STATION_COPY.softphoneJoinBody}</p>
      {callPending ? <p className={styles.fatalLine} data-testid="join-softphone-call-pending">{STATION_COPY.softphoneCallOpen}</p> : null}
      {failure ? <p className={styles.refusal} data-testid="join-close-softphone-failure">{failure}</p> : null}
    </JoinFrame>
  );
}
