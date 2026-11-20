import { Link } from 'react-router-dom';
import { agentLandingPath } from '../../utils/agencyStationExit';
import styles from './AgentStation.module.css';

/**
 * Where the way off a screen with no station on it goes. It is the same question Finish work
 * answers: a supervisor has a campaign page to return to, an `agent` (level 5) does not and is
 * sent to their landing screen, with `refused`, so it does not resolve their assignment and send
 * them straight back here.
 */
export function stationEscapePath(toCampaign: boolean, campaignId: string): string {
  return toCampaign ? `/agency/campaigns/${campaignId}` : agentLandingPath('refused');
}

/** The soft phone page's way off (the station's own join screens use {@link stationEscapePath}). */
export function StationEscape({ toCampaign, campaignId }: { toCampaign: boolean; campaignId: string }) {
  return (
    <Link className={styles.fatalEscape} to={stationEscapePath(toCampaign, campaignId)} data-testid="station-escape">
      {toCampaign ? 'Back to the campaign' : 'Back to your home screen'}
    </Link>
  );
}
