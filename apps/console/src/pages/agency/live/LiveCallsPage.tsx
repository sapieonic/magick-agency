import { PageDescription } from '../../../components/common/PageDescription';
import { LiveCallsTable } from '../../../components/listen/LiveCallsTable';
import styles from '../AgencyCampaignAttemptsPage.module.css';

export const LIVE_CALLS_DESCRIPTION =
  'The calls in progress in this account: who is on each one, with whom, for how long, whether it is being recorded and who '
  + 'is listening. Supervisors who may listen can listen in silently; the agent and the customer hear nothing.';

/**
 * `/agency/live` — "Live calls" (`docs/listening.md` §9): the account's calls in progress, read
 * every 5 s while the page is visible, with Listen for a supervisor who holds
 * `agency.calls.listen`. The listening bar it opens is the shell's (`ConsoleLayout`), so a listen
 * carries on when the supervisor moves to another page.
 *
 * Behind the listening flag (the route's `RequireFlag`, LS1) on top of the `/agency` subtree's
 * gates; the table says what it says to a reader below `agency.supervise`, which the server
 * enforces on the read.
 */
export default function LiveCallsPage() {
  return (
    <div className={styles.page}>
      <PageDescription
        pageKey="agency-live-calls"
        description={LIVE_CALLS_DESCRIPTION}
        tips={[
          'Numbers are masked. Show reveals one row’s full number while you are on this page.',
          'Every listen is logged with your name, the call and when you started and stopped.',
          'The listening bar stays at the bottom of the console while you move between pages.',
        ]}
      />
      <LiveCallsTable headingLevel="h1" />
    </div>
  );
}
