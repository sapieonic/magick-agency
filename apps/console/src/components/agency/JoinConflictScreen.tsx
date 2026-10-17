import { Link } from 'react-router-dom';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { StationEscape } from './StationFatal';
import {
  SWITCH_CONFIRM_ACTION,
  SWITCH_CONFIRM_TITLE,
  conflictIsMidCall,
  joinConflictCopy,
  switchActionLabel,
  switchConfirmMessage,
} from '../../utils/agencyJoinConflict';
import type { AgencySessionConflict } from '../../types/agency';
import styles from './AgentStation.module.css';

/**
 * The join conflict, ahead of every other refusal — both are "the station did
 * not open", and this one is the case with a remedy in it. One live session per
 * agent per TENANT (deliberate: the earlier per-campaign limit was superseded),
 * so being refused here means they are still joined somewhere else, and the link
 * is the way to the Leave-station control that frees them.
 *
 * The switch itself — leave there, rejoin here — is `useStationJoin`'s.
 */
export function JoinConflictScreen({
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
  conflict: AgencySessionConflict;
  /** Where the escape goes — see `StationEscape`. */
  toCampaign: boolean;
  campaignId: string;
  /** The switch dialog is open. */
  confirming: boolean;
  switching: boolean;
  switchFailure: string | null;
  onBeginSwitch: () => void;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}) {
  const copy = joinConflictCopy(conflict);
  // Only when it is safe: mid-call, the other station may only be left by
  // physically going there and finishing what is on screen — see
  // `conflictIsMidCall`.
  const midCall = conflictIsMidCall(conflict.state);
  return (
    <div className={styles.shell}>
      <div className={styles.fatal} role="alert" data-testid="join-conflict">
        <h1>{copy.headline}</h1>
        <p>{copy.detail}</p>
        <p>{copy.remedy}</p>
        {!midCall && (
          <button
            type="button"
            className={styles.fatalAction}
            // A fresh attempt at a (possibly brand-new, post-swap) conflict
            // always starts from scratch — `useStationJoin`'s `beginSwitch`.
            onClick={onBeginSwitch}
            data-testid="switch-station"
          >
            {switchActionLabel(conflict)}
          </button>
        )}
        {/*
          The one remaining way there when a direct switch is not offered
          (mid-call) or not wanted — quieter once the button above exists,
          primary again when it does not.
        */}
        <Link
          className={midCall ? styles.fatalAction : styles.fatalEscape}
          to={`/station?campaign=${encodeURIComponent(conflict.campaign_id)}`}
        >
          {copy.linkLabel}
        </Link>
        {/* The other station may refuse them too — a stopped campaign, say —
            so even this screen keeps the escape below it. */}
        <StationEscape toCampaign={toCampaign} campaignId={campaignId} />
      </div>

      {/*
        Shares `ConfirmDialog` with `Leave station` below — same focus trap,
        same Escape handling, same reason a failure replaces the message
        rather than appending to it. `disabled` is deliberately the only
        thing guarding a mid-flight request: `onCancel` still fires on
        Escape/overlay-click, and letting it close the dialog while
        `confirmSwitch`'s chain is still running would land its eventual
        rejection on a surface nobody can see, same as `confirmLeave`'s.
      */}
      <ConfirmDialog
        open={confirming}
        title={SWITCH_CONFIRM_TITLE}
        message={switchFailure ?? switchConfirmMessage(conflict)}
        confirmLabel={switching ? 'Switching…' : SWITCH_CONFIRM_ACTION}
        disabled={switching}
        onConfirm={onConfirmSwitch}
        onCancel={onCancelSwitch}
      />
    </div>
  );
}
