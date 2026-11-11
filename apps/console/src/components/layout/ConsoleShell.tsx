import { useLocation } from 'react-router-dom';
import { AgentLanding } from '../agency/AgentLanding';
import { isAgencyPath } from '../../utils/consoleNav';
import { ConsoleLayout } from './ConsoleLayout';

/**
 * The shell as `App.tsx` mounts it: `ConsoleLayout` behind `AgentLanding`, which sends a
 * DEDICATED agent from Settings and the legacy `/app` URLs to `/dialer` (as it did for the old
 * `/app` shell). It is switched off under `/agency`, whose pages send an agent to their own
 * `/dialer/*` twin. The layout renders in the same place either way, so crossing between
 * `/agency` and `/settings` does not remount it.
 */
export function ConsoleShell() {
  const { pathname } = useLocation();
  return (
    <AgentLanding enabled={!isAgencyPath(pathname)}>
      <ConsoleLayout />
    </AgentLanding>
  );
}
