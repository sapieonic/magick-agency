import { AgentLanding } from '../agency/AgentLanding';
import { ConsoleLayout } from './ConsoleLayout';

/**
 * The shell as `App.tsx` mounts it: `ConsoleLayout` behind `AgentLanding`, which sends a
 * DEDICATED agent from every page in it to the dialer (a page's own `/dialer/*` twin when it
 * has one, else `/dialer`), as the old `/app` shell did for its pages. The layout renders in
 * the same place on every path, so crossing between `/agency` and `/settings` does not
 * remount it.
 */
export function ConsoleShell() {
  return (
    <AgentLanding>
      <ConsoleLayout />
    </AgentLanding>
  );
}
