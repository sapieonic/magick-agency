import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Headset, Phone, Plus, Search } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useNavGate } from '../../hooks/useNavGate';
import { hasPermission } from '../../utils/permissions';
import { CONSOLE_SECTIONS, DIALER_PATH, passesGate } from '../../utils/consoleNav';
import {
  countCampaigns,
  filterCampaigns,
  type CampaignCounts,
  type CampaignFilter,
} from '../../utils/agencyCampaignsHome';
import { campaignFilterFromParams, withCampaignFilter } from '../../utils/agencyCampaignsFilterParam';
import { formatCount, plural } from '../../utils/format/number';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useCampaignsHome } from './campaigns-home/useCampaignsHome';
import { useActiveCards } from './campaigns-home/useActiveCards';
import { ActiveCampaignCard } from './campaigns-home/ActiveCampaignCard';
import { CampaignRow } from './campaigns-home/CampaignRow';
import { RulesCard } from './campaigns-home/Rules';
import { GetStarted } from './campaigns-home/GetStarted';
import { InboundQueueTiles } from '../../components/agency/inbound/InboundQueueTiles';
import styles from './AgencyCampaignsPage.module.css';

/**
 * The Campaigns page: the account's campaigns, as a list (decision B28a). A viewer or an
 * operator lands here from `/agency`; a supervisor lands on Home, which answers what needs them,
 * and comes here for the list.
 *
 * Two parts, and each one answers its own question:
 *
 *  - **Active now**: what has started and not finished, and is it healthy? One
 *    card per running, stopping or paused campaign, with the health strip's top
 *    diagnosis, its floor and its 24-hour abandonment, all from ONE read of Home's
 *    board (`useActiveCards`), for the first 25; past that the section links to
 *    the Active tab. Rows in the list carry no live numbers: N reads to decorate a
 *    list is numbers nobody reads at that level.
 *  - **All campaigns**: the list, grouped by filter tabs whose counts double as
 *    the account's summary, with a name search once the list is long enough to
 *    need one, and older campaigns a page at a time.
 *
 * The two are read separately. The history is paged, newest first; the active
 * campaigns are read in full with the list's `status` filter, because any
 * number can be paused and an old one would otherwise sit unseen on a page
 * nobody loaded, while the card section said nothing was dialing.
 *
 * Beside the list sit the three rules every newcomer trips on once; on a narrow
 * screen they drop below it. Nothing here repeats the sidebar: its entries are
 * the way to Analytics, Do Not Call and Settings. The one action is the reader's
 * own: New campaign for whoever can create one, and Take calls for a reader who
 * takes calls but does not supervise (the sidebar's `dialer` entry, gated as it is).
 *
 * With no campaigns at all, the page is a getting-started guide instead, and the
 * rules move into it. That is where a newcomer is, and a page guide stacked
 * above an empty box told them the rules before telling them what to do.
 *
 * Layout is driven by container queries, not viewport media queries: the
 * sidebar takes a brand-dependent width, so the content box, not the window,
 * decides how many columns fit.
 */

/** The sidebar's Take calls entry (its one tab opens `/dialer`): this page offers it to whoever the sidebar does. */
const TAKE_CALLS_GATE = CONSOLE_SECTIONS.flatMap((s) => s.tabs).find((t) => t.to === DIALER_PATH)!.gate;

/** Below this many campaigns the tabs are enough, and a search box is clutter. */
const SEARCH_THRESHOLD = 6;

const FILTERS: Array<{ key: CampaignFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'draft', label: 'Drafts' },
  { key: 'finished', label: 'Finished' },
];

export function AgencyCampaignsPage() {
  const { tenantId, accountId, role, accounts } = useTenant();
  const {
    history,
    total,
    error,
    loading,
    loadingMore,
    moreError,
    campaigns,
    sorted,
    active,
    load,
    loadMore,
  } = useCampaignsHome(tenantId, accountId);
  const cards = useActiveCards(tenantId, accountId, role, active, () => load(true));
  const canTakeCalls = passesGate(TAKE_CALLS_GATE, useNavGate());
  const [searchParams, setSearchParams] = useSearchParams();
  // In the URL, so a reload and Back keep it (`campaignFilterFromParams`). Replaced, not pushed:
  // a filter change is not a page for Back to step through.
  const filter = campaignFilterFromParams(searchParams);
  const setFilter = (next: CampaignFilter) => {
    setSearchParams((prev) => withCampaignFilter(prev, next), { replace: true });
  };
  const [query, setQuery] = useState('');
  const canCreate = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  const counts = useMemo(() => countCampaigns(sorted), [sorted]);
  const visible = useMemo(() => filterCampaigns(sorted, filter, query), [sorted, filter, query]);
  const partial = (history?.length ?? 0) < total;

  const isEmpty = !loading && campaigns?.length === 0;
  const hasCampaigns = (campaigns?.length ?? 0) > 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          {accountName && <p className={styles.eyebrow}>{accountName}</p>}
          <h1 className={styles.title}>Campaigns</h1>
          <p className={styles.subtitle}>
            {hasCampaigns
              ? summaryLine(counts, total, partial ? (history?.length ?? 0) : null)
              : 'Dial a list of contacts and connect every answered call to a live agent.'}
          </p>
        </div>
        {canCreate && hasCampaigns && (
          <Link to="/agency/campaigns/new" className={`btn-primary ${styles.headerAction}`}>
            <Plus size={16} aria-hidden="true" />
            New campaign
          </Link>
        )}
        {canTakeCalls && (
          <Link to={DIALER_PATH} className={`btn-primary ${styles.headerAction}`}>
            <Headset size={16} aria-hidden="true" />
            Take calls
          </Link>
        )}
      </header>

      {/* Inbound calls (P2): the supervisor's queue, polled; renders nothing without the flag. */}
      <InboundQueueTiles />

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {loading && !campaigns && <LoadingSpinner />}

      {isEmpty && <GetStarted canCreate={canCreate} canInvite={hasPermission(role, 'user.invite')} />}

      {hasCampaigns && (
        <div className={styles.layout}>
          <div className={styles.mainCol}>
            <section className={styles.section} aria-labelledby="campaigns-active-heading">
              <h2 id="campaigns-active-heading" className={styles.sectionTitle}>
                Active now
              </h2>
              {active.length > 0 ? (
                <>
                  <div className={styles.liveGrid}>
                    {cards.shown.map((c) => (
                      <ActiveCampaignCard key={c.id} campaign={c} state={cards.states[c.id] ?? { status: 'loading' }} />
                    ))}
                  </div>
                  {cards.more > 0 && (
                    <p className={styles.moreText} data-testid="active-more">
                      {`And ${plural(cards.more, 'more active campaign')}. `}
                      <Link to={{ search: withCampaignFilter(searchParams, 'active').toString() }}>
                        See every active campaign
                      </Link>
                    </p>
                  )}
                </>
              ) : (
                <div className={styles.idle}>
                  <span className={styles.idleIcon} aria-hidden="true">
                    <Phone size={18} />
                  </span>
                  <div>
                    <p className={styles.idleTitle}>Nothing is dialling right now</p>
                    <p className={styles.idleText}>
                      {counts.draft > 0
                        ? 'Open a draft and start it when its contacts and agents are ready.'
                        : 'Start a new campaign when you have a list ready to call.'}
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className={styles.section} aria-labelledby="campaigns-all-heading">
              <h2 id="campaigns-all-heading" className={styles.sectionTitle}>
                All campaigns
              </h2>

              <div className={styles.toolbar}>
                <div className={styles.tabs} role="group" aria-label="Filter campaigns by status">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={filter === f.key}
                      className={`${styles.tab} ${filter === f.key ? styles.tabActive : ''}`}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label}
                      <span className={styles.tabCount}>{counts[f.key]}</span>
                    </button>
                  ))}
                </div>
                {total > SEARCH_THRESHOLD && (
                  <label className={styles.search}>
                    <Search size={15} aria-hidden="true" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by name"
                      aria-label="Search campaigns by name"
                    />
                  </label>
                )}
              </div>

              {visible.length > 0 ? (
                // `role="list"`: Safari drops list semantics from a list with
                // `list-style: none`, and the count is what a screen reader uses.
                <ul className={styles.list} role="list" aria-labelledby="campaigns-all-heading">
                  {visible.map((c) => (
                    <li key={c.id}>
                      <CampaignRow campaign={c} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.noMatch}>
                  {query.trim() ? `No campaigns match “${query.trim()}”.` : 'No campaigns in this group.'}
                </p>
              )}

              {partial && (
                <div className={styles.more}>
                  <p className={styles.moreText}>
                    Showing the latest {formatCount(history?.length ?? 0)} of {formatCount(total)},
                    and every active campaign. Tab counts and search cover the campaigns shown.
                  </p>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Show older campaigns'}
                  </button>
                  {moreError && <p className={styles.moreError}>{moreError}</p>}
                </div>
              )}
            </section>
          </div>

          <div className={styles.rail}>
            <RulesCard />
          </div>
        </div>
      )}
    </div>
  );
}

/** `shown` is how many of the history are loaded when that is not all of it, else null. */
function summaryLine(counts: CampaignCounts, total: number, shown: number | null): string {
  const all = `${formatCount(total)} ${total === 1 ? 'campaign' : 'campaigns'}`;
  // Active campaigns are always read in full, so their count holds. The other
  // groups describe only the rows loaded and would undercount; the line says
  // what is shown instead.
  if (shown !== null) {
    const active = counts.active > 0 ? ` · ${counts.active} active` : '';
    return `${all}${active} · latest ${formatCount(shown)} shown`;
  }
  const parts = [
    counts.active > 0 ? `${counts.active} active` : null,
    counts.draft > 0 ? `${counts.draft} ${counts.draft === 1 ? 'draft' : 'drafts'}` : null,
    counts.finished > 0 ? `${counts.finished} finished` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${all} · ${parts.join(' · ')}` : all;
}

export default AgencyCampaignsPage;
