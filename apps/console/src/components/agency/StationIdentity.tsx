import { stationAgentLabel } from '../../utils/agencyStationIdle';
import { UserAvatar } from '../common/UserAvatar';
import styles from './StationIdentity.module.css';

export interface StationIdentityUser {
  display_name: string | null;
  email: string;
  avatar_url: string | null;
}

/**
 * Who is on this station, in the header.
 *
 * The console is full-viewport and outside every shell, so there is no profile
 * menu to read. A shared seat, a supervisor covering a shift, or an agent
 * who just sat down at the next desk all need the same fact: whose session
 * this is. Display-only — a button here would compete with the station menu
 * beside it, and one of those items ends the session.
 *
 * Presentational on purpose: the page reads `useAuth` and passes the user in,
 * so this chip can render in tests and previews without an AuthProvider.
 */
export function StationIdentity({
  user,
  subline,
}: {
  user: StationIdentityUser | null | undefined;
  subline: string;
}) {
  const name = stationAgentLabel(user);

  return (
    <div className={styles.wrap} data-testid="station-identity">
      <UserAvatar user={user} size="md" />
      <div className={styles.text}>
        <span className={styles.name}>{name}</span>
        <span className={styles.subline}>{subline}</span>
      </div>
    </div>
  );
}
