import { Link } from 'react-router-dom';
import { agentLandingPath } from '../../utils/agencyStationExit';
import styles from './AgentStation.module.css';

/**
 * The way off a station screen that has no station on it.
 *
 * Both fatal screens render before the console's header, so this link is the
 * only navigation on them. Where it goes is the same question `Exit station`
 * answers: a supervisor has a campaign page to return to, an `agent` (level 5)
 * does not and is sent to their landing screen — with `refused`, so it does not
 * resolve their assignment and send them straight back here.
 */
export function StationEscape({ toCampaign, campaignId }: { toCampaign: boolean; campaignId: string }) {
  return (
    <Link
      className={styles.fatalEscape}
      to={toCampaign ? `/agency/campaigns/${campaignId}` : agentLandingPath('refused')}
      data-testid="station-escape"
    >
      {toCampaign ? 'Back to the campaign' : 'Back to your home screen'}
    </Link>
  );
}

/**
 * The station that did not open: why, and the way off it.
 *
 * Rendered by `AgentConsolePage` in place of the console when the join failed
 * for any reason other than a session on another campaign (that one is
 * `JoinConflictScreen`, because it has a remedy in it).
 */
export function StationFatal({
  message,
  toCampaign,
  campaignId,
}: {
  message: string;
  toCampaign: boolean;
  campaignId: string;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.fatal} role="alert">
        <h1>Can’t open the station</h1>
        <p>{message}</p>
        {/*
          ── This screen used to be a trap, and it is the common one ─────────
          It returns before the header, so there is no `StationMenu`, no nav,
          and no sidebar (the console is full-viewport, outside `AppLayout`).
          An assigned agent whose campaign is paused or stopped is refused
          here — and every route back (`/app`, `/`, the catch-all) resolves
          their assignment and returns them to this same screen. The only
          escape was a query param they could not know existed.

          The conflict screen above was given a link precisely because a dead
          end was unacceptable. This failure is far more likely than that one.
        */}
        <StationEscape toCampaign={toCampaign} campaignId={campaignId} />
      </div>
    </div>
  );
}
