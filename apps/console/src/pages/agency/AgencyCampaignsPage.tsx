import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMountedRef } from '../../hooks/useMountedRef';
import { Link } from 'react-router-dom';
import {
  ChartNoAxesCombined,
  ChevronRight,
  Clock,
  ListChecks,
  Phone,
  PhoneOff,
  Plus,
  Search,
  TriangleAlert,
  Upload,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import {
  getAgencyCampaign,
  listAgencyCampaigns,
  listAgencyCampaignsPage,
  getAgencyCampaignStats,
} from '../../api/agencyCampaigns';
import { hasPermission, type Permission } from '../../utils/permissions';
import { mapWithConcurrency } from '@magick-agency/web-ui/concurrency';
import { listWorkedRing } from '../../utils/agencyCampaignOverview';
import { stallCopy } from '../../utils/agencyHealthStrip';
import { lineagePositionLabel } from '../../utils/agencyCampaignLineage';
import { formatDate, formatRelativeTime } from '@magick-agency/web-ui/format';
import {
  campaignGroup,
  countCampaigns,
  filterCampaigns,
  needsPolling,
  scheduleLabel,
  sortCampaigns,
  type CampaignCounts,
  type CampaignFilter,
} from '../../utils/agencyCampaignsHome';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { LiveDot } from '../../components/common/LiveDot';
import { WorkspaceExit } from '../../components/agency/WorkspaceExit';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import styles from './AgencyCampaignsPage.module.css';

/**
 * The campaigns home: the page a supervisor lands on in `/agency`.
 *
 * Three parts, and each one answers its own question:
 *
 *  - **Active now**: what has started and not finished, and is it healthy? One
 *    card per running, stopping or paused campaign, with its live numbers and
 *    the health strip's top diagnosis. This is the only part that reads
 *    `/stats`, and only for those campaigns. Rows in the list stay stats-free
 *    for the reason they always were: N round trips to decorate a list is
 *    numbers nobody reads at that level.
 *  - **All campaigns**: the list, grouped by filter tabs whose counts double as
 *    the account's summary, with a name search once the list is long enough to
 *    need one, and older campaigns a page at a time.
 *
 * The two are read separately. The history is paged, newest first; the active
 * campaigns are read in full with the list's `status` filter, because any
 * number can be paused and an old one would otherwise sit unseen on a page
 * nobody loaded, while the card section said nothing was dialing.
 *  - **The rail**: the workspace's other destinations and the three rules every
 *    supervisor trips on once. On a wide screen it sits beside the list; on a
 *    narrow one it drops below it.
 *
 * With no campaigns at all, the page is a getting-started guide instead, and the
 * rules move into it. That is where a newcomer is, and a page guide stacked
 * above an empty box told them the rules before telling them what to do.
 *
 * Layout is driven by container queries, not viewport media queries: the
 * sidebar takes a brand-dependent width, so the content box, not the window,
 * decides how many columns fit.
 */

/** The cards' refresh, matching the campaign detail page's own poll. */
const REFRESH_MS = 10_000;

/** Rows per request; the server caps `limit` at 100. */
const PAGE_SIZE = 100;

/** Every started-and-not-finished status: the ones read in full, however old. */
const ACTIVE_STATUSES = ['running', 'stopping', 'paused'];

/** Below this many campaigns the tabs are enough, and a search box is clutter. */
const SEARCH_THRESHOLD = 6;

type StatsState =
  | { status: 'loading' }
  | { status: 'ready'; stats: AgencyCampaignStats }
  | { status: 'error' };

const FILTERS: Array<{ key: CampaignFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'draft', label: 'Drafts' },
  { key: 'finished', label: 'Finished' },
];

function readyStats(state: StatsState | undefined): AgencyCampaignStats | null {
  return state?.status === 'ready' ? state.stats : null;
}

/**
 * A poll's first page laid over the history already on screen.
 *
 * Without older pages loaded, the first page simply replaces it. With them,
 * rows the poll did not return are kept after it: a campaign created since
 * pushes the last row of page one onto page two, and dropping it would make a
 * campaign disappear for no reason the supervisor can see.
 *
 * That reasoning rests on campaigns never being deleted (there is no delete
 * route), so a row missing from page one has moved down, not gone. It is also
 * why the history's length is a safe offset for the next page: inserts only
 * push rows down, so a later page can repeat a row already held (dropped by id)
 * but never skip one.
 */
function mergeFirstPage(prev: AgencyCampaign[] | null, page: AgencyCampaign[]): AgencyCampaign[] {
  if (!prev || prev.length <= PAGE_SIZE) return page;
  const ids = new Set(page.map((c) => c.id));
  return [...page, ...prev.filter((c) => !ids.has(c.id))];
}

/**
 * The history with every active campaign in it. An active campaign's row from
 * the active read replaces its history row, and one older than the loaded
 * pages is added, so the cards, the Active tab and the list all agree.
 */
function withActive(history: AgencyCampaign[], live: AgencyCampaign[]): AgencyCampaign[] {
  const byId = new Map(live.map((c) => [c.id, c]));
  const merged = history.map((c) => byId.get(c.id) ?? c);
  const held = new Set(history.map((c) => c.id));
  return [...merged, ...live.filter((c) => !held.has(c.id))];
}

function isActive(c: AgencyCampaign): boolean {
  return campaignGroup(c.status) === 'active';
}

export function AgencyCampaignsPage() {
  const { tenantId, accountId, role, accounts } = useTenant();
  /** The paged history, newest first. Its length is the next page's offset. */
  const [history, setHistory] = useState<AgencyCampaign[] | null>(null);
  /** Every active campaign, whatever page its history row is on. */
  const [live, setLive] = useState<AgencyCampaign[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, StatsState>>({});
  const [filter, setFilter] = useState<CampaignFilter>('all');
  const [query, setQuery] = useState('');

  const historyRef = useRef(history);
  historyRef.current = history;
  const generation = useRef(0);
  /** Per campaign, the newest stats request. An older answer arriving later is dropped. */
  const statsSeq = useRef(new Map<string, number>());
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const mounted = useMountedRef();

  /** `quiet` is the poll: it refreshes in place, without the spinner or a cleared error. */
  const load = useCallback(
    async (quiet = false) => {
      if (!tenantId || !accountId) return;
      // Only a full load starts a new generation. A poll answers for the one
      // already on screen, and must not orphan a retry that is still in flight.
      const mine = quiet ? generation.current : (generation.current += 1);
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await listAgencyCampaignsPage(tenantId, accountId, 0, PAGE_SIZE);
        // When the first page is the whole account, its active rows are all of
        // them. Otherwise they are read in full. Filtered here as well, so a
        // server that ignored `status` could not put a draft on a card.
        const liveRows = (
          page.total > page.campaigns.length
            ? await listAgencyCampaigns(tenantId, accountId, ACTIVE_STATUSES)
            : page.campaigns
        ).filter(isActive);
        // Only page one is re-read on a poll. A row on an older loaded page that
        // still says active, but is missing from the complete active read, has
        // finished since: re-read it, so it shows how it ended rather than a
        // stale Paused. Usually there are none, and so no requests.
        const liveIds = new Set(liveRows.map((c) => c.id));
        const firstIds = new Set(page.campaigns.map((c) => c.id));
        const stale = quiet
          ? (historyRef.current ?? []).filter((c) => isActive(c) && !liveIds.has(c.id) && !firstIds.has(c.id))
          : [];
        const reread = await mapWithConcurrency(stale, (c) => getAgencyCampaign(c.id, tenantId, accountId));
        const ended = new Map(
          reread.flatMap((o) => (o.status === 'fulfilled' ? [[o.value.id, o.value] as const] : [])),
        );
        if (!mounted.current || generation.current !== mine) return;
        setHistory((prev) => {
          const next = quiet ? mergeFirstPage(prev, page.campaigns) : page.campaigns;
          return ended.size > 0 ? next.map((c) => ended.get(c.id) ?? c) : next;
        });
        setLive(liveRows);
        setTotal(page.total);
      } catch (err: unknown) {
        // A failed poll keeps the list already on screen; only a full load has
        // nothing better to show than the error.
        if (mounted.current && generation.current === mine && !quiet) {
          setError(err instanceof Error ? err.message : 'Could not load campaigns.');
        }
      } finally {
        if (mounted.current && generation.current === mine && !quiet) setLoading(false);
      }
    },
    [tenantId, accountId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!tenantId || !accountId || !history) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      // The history's own length, never the merged list's: active campaigns
      // added from the active read were not served by these pages, and counting
      // them would skip as many rows.
      const page = await listAgencyCampaignsPage(tenantId, accountId, history.length, PAGE_SIZE);
      if (!mounted.current || generation.current !== mine) return;
      setHistory((prev) => {
        const have = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...page.campaigns.filter((c) => !have.has(c.id))];
      });
      setTotal(page.total);
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : 'Could not load more campaigns.');
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [tenantId, accountId, history]);

  const campaigns = useMemo(() => (history ? withActive(history, live) : null), [history, live]);
  const sorted = useMemo(() => (campaigns ? sortCampaigns(campaigns) : []), [campaigns]);
  const active = useMemo(() => sorted.filter(isActive), [sorted]);
  const activeIds = useRef<Set<string>>(new Set());
  activeIds.current = new Set(active.map((c) => c.id));

  /**
   * Read `/stats` for the given campaigns and merge the answers in.
   *
   * Merged per campaign rather than rebuilt, and guarded per campaign by
   * `statsSeq`, so a slow answer can neither overwrite a newer one nor wipe the
   * entries of campaigns it was not asked about. A failed refresh keeps the last
   * good numbers rather than blanking a card the supervisor is reading.
   */
  const fetchStats = useCallback(
    async (ids: string[]) => {
      if (!tenantId || !accountId || ids.length === 0) return;
      const tickets = ids.map((id) => {
        const next = (statsSeq.current.get(id) ?? 0) + 1;
        statsSeq.current.set(id, next);
        return next;
      });
      const settled = await mapWithConcurrency(ids, (id) =>
        getAgencyCampaignStats(id, tenantId, accountId),
      );
      if (!mounted.current) return;
      setStats((prev) => {
        const next: Record<string, StatsState> = {};
        // Campaigns that have left the active set have no card; drop their entries.
        for (const [id, state] of Object.entries(prev)) {
          if (activeIds.current.has(id)) next[id] = state;
        }
        ids.forEach((id, i) => {
          if (!activeIds.current.has(id) || statsSeq.current.get(id) !== tickets[i]) return;
          const outcome = settled[i]!;
          if (outcome.status === 'fulfilled') {
            next[id] = { status: 'ready', stats: outcome.value };
          } else if (prev[id]?.status !== 'ready') {
            next[id] = { status: 'error' };
          }
        });
        return next;
      });
    },
    [tenantId, accountId],
  );

  /*
    A campaign entering the active set, or changing status within it (paused in
    another tab, say), gets read straight away rather than at the next tick. The
    key carries status for exactly that reason.
  */
  const activeKey = active.map((c) => `${c.id}:${c.status}`).join(',');
  const seenKey = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const changed = active
      .filter((c) => seenKey.current.get(c.id) !== c.status)
      .map((c) => c.id);
    seenKey.current = new Map(active.map((c) => [c.id, c.status]));
    void fetchStats(changed);
    // `activeKey` stands in for `active`: a re-sorted list with the same
    // campaigns in the same states must not refetch.
  }, [activeKey, fetchStats]);

  const polling = active.some((c) => needsPolling(c.status, readyStats(stats[c.id])));
  // Read through a ref so `refresh` stays stable: every poll replaces the list,
  // and a callback that changed with it would restart the interval each time.
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  const tickBusy = useRef(false);
  const refresh = useCallback(
    async (only: 'polling' | 'all') => {
      // One refresh at a time: a slow backend must not stack ticks on top of each other.
      if (tickBusy.current) return;
      tickBusy.current = true;
      try {
        const ids = sortedRef.current
          .filter(isActive)
          .filter((c) => only === 'all' || needsPolling(c.status, readyStats(statsRef.current[c.id])))
          .map((c) => c.id);
        await Promise.all([load(true), fetchStats(ids)]);
      } finally {
        tickBusy.current = false;
      }
    },
    [load, fetchStats],
  );

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh('polling');
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  /*
    Coming back to the tab re-reads everything once, polling or not: that is the
    only way to notice a campaign resumed or started from another window when
    nothing here was moving. `focus` as well as `visibilitychange`, because two
    side-by-side windows both stay visible (the detail page does the same).
  */
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'visible') void refresh('all');
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [refresh]);

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
      </header>

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
                <div className={styles.liveGrid}>
                  {active.map((c) => (
                    <ActiveCampaignCard key={c.id} campaign={c} state={stats[c.id] ?? { status: 'loading' }} />
                  ))}
                </div>
              ) : (
                <div className={styles.idle}>
                  <span className={styles.idleIcon} aria-hidden="true">
                    <Phone size={18} />
                  </span>
                  <div>
                    <p className={styles.idleTitle}>Nothing is dialing right now</p>
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
                    Showing the latest {(history?.length ?? 0).toLocaleString()} of {total.toLocaleString()},
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
            <Shortcuts role={role} />
            <RulesCard />
          </div>
        </div>
      )}
    </div>
  );
}

/** `shown` is how many of the history are loaded when that is not all of it, else null. */
function summaryLine(counts: CampaignCounts, total: number, shown: number | null): string {
  const all = `${total.toLocaleString()} ${total === 1 ? 'campaign' : 'campaigns'}`;
  // Active campaigns are always read in full, so their count holds. The other
  // groups describe only the rows loaded and would undercount; the line says
  // what is shown instead.
  if (shown !== null) {
    const active = counts.active > 0 ? ` · ${counts.active} active` : '';
    return `${all}${active} · latest ${shown.toLocaleString()} shown`;
  }
  const parts = [
    counts.active > 0 ? `${counts.active} active` : null,
    counts.draft > 0 ? `${counts.draft} ${counts.draft === 1 ? 'draft' : 'drafts'}` : null,
    counts.finished > 0 ? `${counts.finished} finished` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${all} · ${parts.join(' · ')}` : all;
}

// ── Active now ──────────────────────────────────────────────────────────────

function figure(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function ActiveCampaignCard({ campaign, state }: { campaign: AgencyCampaign; state: StatsState }) {
  const stats = readyStats(state);
  const dialing = campaign.status === 'running';
  const worked = listWorkedRing(stats);
  const stall = stats?.stall ? stallCopy(stats.stall, formatDate) : null;
  const href = `/agency/campaigns/${campaign.id}`;

  return (
    <article className={styles.liveCard} data-testid="active-campaign" aria-labelledby={`campaign-${campaign.id}`}>
      <div className={styles.liveHead}>
        <div className={styles.liveName}>
          <span className={styles.liveTitleRow}>
            <LiveDot live={dialing} color={dialing ? undefined : 'var(--warning)'} />
            <h3 id={`campaign-${campaign.id}`} className={styles.liveHeading}>
              <Link to={href} className={styles.liveTitle}>
                {campaign.name}
              </Link>
            </h3>
          </span>
          <AgencyCampaignStatusBadge status={campaign.status} />
        </div>
        <Link to={href} className={`btn-secondary ${styles.liveOpen}`} aria-label={`Open ${campaign.name}`}>
          Open
          <ChevronRight size={15} aria-hidden="true" />
        </Link>
      </div>

      {/* Not a live region: the headline can carry a count that changes on every
          poll ("5 of 10 lines in use"), and announcing it every ten seconds would
          drown the page. The detail page is where a diagnosis is followed. */}
      {stall && (
        <p className={styles.stall}>
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{stall.headline}</span>
        </p>
      )}

      {state.status === 'error' ? (
        <p className={styles.liveError}>Live numbers didn’t load. Open the campaign to see them.</p>
      ) : (
        <>
          <dl className={styles.metrics}>
            <Metric label="Calls in progress" value={figure(stats?.attempts_live)} />
            <Metric label="Agents on the floor" value={figure(stats?.agents_live)} />
            {/* "Reached someone", as on the detail page: `attempts_connected`
                counts answering machines too. A person is `human_connects`. */}
            <Metric
              label="Reached someone"
              value={figure(stats?.attempts_connected)}
              sub={`of ${figure(stats?.attempts_total)} dials`}
            />
            <Metric label="Waiting to dial" value={figure(stats?.contacts_pending)} />
          </dl>

          <div className={styles.progress}>
            <div className={styles.progressHead}>
              <span>List worked</span>
              <span className={styles.progressValue}>{worked.label}</span>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="List worked"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={worked.percent === null ? undefined : Math.round(worked.percent)}
              aria-valuetext={worked.known ? undefined : 'Not known yet'}
            >
              <div
                className={`${styles.progressFill} ${dialing ? styles.progressFillLive : ''}`}
                style={{ width: `${Math.min(Math.max(worked.percent ?? 0, 0), 100)}%` }}
              />
            </div>
            <p className={styles.progressCaption}>
              {state.status === 'loading' ? 'Loading live numbers…' : worked.caption}
            </p>
          </div>
        </>
      )}
    </article>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.metric}>
      <dt className={styles.metricLabel}>{label}</dt>
      <dd className={styles.metricValue}>
        {value}
        {sub && <span className={styles.metricSub}>{sub}</span>}
      </dd>
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

/**
 * When it ran, in a few words. `started_at: null` is "the server says it never
 * started" and reads "Not started", as the contract asks; `undefined` is "not
 * carried", which says nothing rather than guess.
 */
function rowTiming(campaign: AgencyCampaign): string | null {
  const group = campaignGroup(campaign.status);
  if (group === 'draft') return 'Not started';
  if (group === 'finished' && campaign.ended_at) return `Ended ${formatRelativeTime(campaign.ended_at)}`;
  if (campaign.started_at) return `Started ${formatRelativeTime(campaign.started_at)}`;
  if (campaign.started_at === null) return 'Not started';
  return null;
}

function CampaignRow({ campaign }: { campaign: AgencyCampaign }) {
  const schedule = scheduleLabel(campaign);
  const callerIds = campaign.caller_ids?.length ?? 0;
  const generation = campaign.retry_generation ?? 0;
  const meta = [rowTiming(campaign), generation > 0 ? lineagePositionLabel(generation) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link to={`/agency/campaigns/${campaign.id}`} className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{campaign.name}</span>
        {meta && <span className={styles.rowMeta}>{meta}</span>}
      </div>
      <div className={styles.rowStatus}>
        <AgencyCampaignStatusBadge status={campaign.status} />
      </div>
      <div className={styles.rowDetail}>
        {/* Every campaign has calling hours (the columns are NOT NULL with
            defaults), so a missing one means the payload did not carry it,
            and the row says nothing rather than "none set". */}
        {schedule && (
          <span className={styles.rowFact}>
            <Clock size={13} aria-hidden="true" />
            {schedule}
          </span>
        )}
        {callerIds > 0 && (
          <span className={styles.rowFact}>
            <Phone size={13} aria-hidden="true" />
            {callerIds} {callerIds === 1 ? 'number' : 'numbers'}
          </span>
        )}
      </div>
      <ChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />
    </Link>
  );
}

// ── The rail ────────────────────────────────────────────────────────────────

interface Shortcut {
  label: string;
  hint: string;
  /** An in-shell path, or `exit` for the platform zone (see below). */
  to: string;
  icon: LucideIcon;
  permission: Permission;
}

/* Gated on the same floors as the sidebar entries they mirror, so the rail never
   offers a destination whose first request 403s.

   Team is the platform zone, so it leaves through `WorkspaceExit` with its default
   destination: the platform home sends a `user.invite` holder, the only reader
   shown this entry, straight to Team. */
const SHORTCUTS: Shortcut[] = [
  {
    label: 'Analytics',
    hint: 'Compare campaigns and agents',
    to: '/agency/analytics',
    icon: ChartNoAxesCombined,
    permission: 'agency.campaigns.read',
  },
  {
    label: 'Do Not Call',
    hint: 'Numbers that are never dialed',
    to: '/agency/dnc',
    icon: PhoneOff,
    permission: 'agency.dnc.read',
  },
  {
    label: 'Team',
    hint: 'Invite agents and supervisors',
    to: 'exit',
    icon: Users,
    permission: 'user.invite',
  },
];

function Shortcuts({ role }: { role: Parameters<typeof hasPermission>[0] }) {
  const items = SHORTCUTS.filter((s) => hasPermission(role, s.permission));
  if (items.length === 0) return null;
  return (
    <section className={styles.railCard} aria-labelledby="campaigns-shortcuts-heading">
      <h2 id="campaigns-shortcuts-heading" className={styles.railTitle}>
        Shortcuts
      </h2>
      <ul className={styles.shortcuts} role="list">
        {items.map((s) => {
          const body = (
            <>
              <span className={styles.shortcutIcon} aria-hidden="true">
                <s.icon size={16} />
              </span>
              <span className={styles.shortcutText}>
                <span className={styles.shortcutLabel}>{s.label}</span>
                <span className={styles.shortcutHint}>{s.hint}</span>
              </span>
              <ChevronRight size={15} className={styles.shortcutChevron} aria-hidden="true" />
            </>
          );
          return (
            <li key={s.label}>
              {s.to === 'exit' ? (
                <WorkspaceExit className={styles.shortcut}>{body}</WorkspaceExit>
              ) : (
                <Link to={s.to} className={styles.shortcut}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const RULES = [
  'A campaign starts as a draft. Nothing is dialed until you start it.',
  'Only one campaign can run at a time per account.',
  'Stopping a campaign lets calls already in progress finish.',
];

function Rules() {
  return (
    <ul className={styles.rules} role="list">
      {RULES.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );
}

function RulesCard() {
  return (
    <section className={styles.railCard} aria-labelledby="campaigns-rules-heading">
      <h2 id="campaigns-rules-heading" className={styles.railTitle}>
        Good to know
      </h2>
      <Rules />
    </section>
  );
}

// ── No campaigns yet ────────────────────────────────────────────────────────

const STEPS: Array<{ title: string; text: string; icon: LucideIcon }> = [
  {
    title: 'Create the campaign',
    text: 'Name it, choose the numbers it dials from, and set its calling hours.',
    icon: ListChecks,
  },
  {
    title: 'Add contacts',
    text: 'Upload a CSV roster and map its columns to the contact fields.',
    icon: Upload,
  },
  {
    title: 'Assign agents',
    text: 'Invite your agents to the team and staff them on the campaign.',
    icon: UserPlus,
  },
  {
    title: 'Start dialing',
    text: 'Agents join from the agent station, and answered calls go straight to them.',
    icon: Phone,
  },
];

function GetStarted({ canCreate, canInvite }: { canCreate: boolean; canInvite: boolean }) {
  return (
    <section className={styles.welcome} aria-labelledby="campaigns-welcome-heading">
      <div className={styles.welcomeHero}>
        <span className={styles.welcomeIcon} aria-hidden="true">
          <ListChecks size={22} />
        </span>
        <h2 id="campaigns-welcome-heading" className={styles.welcomeTitle}>
          {canCreate ? 'Launch your first campaign' : 'No campaigns yet'}
        </h2>
        <p className={styles.welcomeText}>
          {canCreate
            ? 'A campaign works through a list of contacts and hands every answered call to an agent who is ready for it. Setting one up takes a few minutes.'
            : 'Campaigns are set up by a supervisor. They will show here as soon as one exists.'}
        </p>
        {canCreate && (
          <div className={styles.welcomeActions}>
            <Link to="/agency/campaigns/new" className="btn-primary">
              <Plus size={16} aria-hidden="true" />
              New campaign
            </Link>
            {/* Lands on Team: see the note on `SHORTCUTS`. */}
            {canInvite && (
              <WorkspaceExit className="btn-secondary">
                <UserPlus size={16} aria-hidden="true" />
                Invite agents
              </WorkspaceExit>
            )}
          </div>
        )}
      </div>

      {/* The steps are instructions, so only a role that can follow them gets them. */}
      {canCreate && (
        <ol className={styles.steps} role="list">
          {STEPS.map((step, i) => (
            <li key={step.title} className={styles.step}>
              <div className={styles.stepHead}>
                <span className={styles.stepNumber}>{i + 1}</span>
                <step.icon size={16} className={styles.stepIcon} aria-hidden="true" />
              </div>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepText}>{step.text}</p>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.welcomeRules}>
        <h3 className={styles.railTitle}>Good to know</h3>
        <Rules />
      </div>
    </section>
  );
}

export default AgencyCampaignsPage;
