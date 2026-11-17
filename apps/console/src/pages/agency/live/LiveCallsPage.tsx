import { PageDescription } from '../../../components/common/PageDescription';
import { LiveCallsTable } from '../../../components/listen/LiveCallsTable';
import { LIVE_CALLS_PAGE_COPY } from '../../../utils/listen/listenCopy';
import styles from '../AgencyCampaignAttemptsPage.module.css';

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
        description={LIVE_CALLS_PAGE_COPY.description}
        tips={[...LIVE_CALLS_PAGE_COPY.tips]}
      />
      <LiveCallsTable headingLevel="h1" />
    </div>
  );
}
