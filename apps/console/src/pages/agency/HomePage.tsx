import { useEffect, useMemo } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ChevronRight, CircleCheck, Plus } from 'lucide-react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import { useTenant } from '../../contexts/TenantContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { useHomeBoard } from '../../hooks/useHomeBoard';
import { useTodaySoFar } from '../../hooks/useTodaySoFar';
import { homeAttentionKey, publishHomeAttentionCount } from '../../hooks/useHomeAttentionCount';
import { hasPermission } from '../../utils/permissions';
import { canSeeHome } from '../../utils/consoleNav';
import {
  homeAttention,
  homeBadgeCount,
  homeFloor,
  homeNeeds,
  homeWaiting,
  todaySuccessLine,
  HOME_CAMPAIGN_CAP,
  type HomeAttentionItem,
  type HomeFloorRow,
} from '../../utils/agency/home';
import { formatCount, plural } from '../../utils/format/number';
import { durationWords } from '../../utils/format/duration';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import { GetStarted } from './campaigns-home/GetStarted';
import styles from './HomePage.module.css';

/** A time on today's date, else the date and time. */
function when(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? formatTime(iso) : formatDate(iso);
}

/**
 * Home (decision B28): what needs the supervisor now, the floor of each live campaign, and
 * today's totals. A supervisor lands here from `/agency` and after an account switch.
 *
 * Gated at `agency.supervise` (`HOME_GATE` in `utils/consoleNav`): every read it makes floors
 * there. Anyone else who opens the URL is sent to `/agency`, whose index picks their landing.
 */
export default function HomePage() {
  const { role, tenantId, accountId, accounts } = useTenant();
  // `HOME_GATE`; the capability and flag are `/agency`'s route gates, already passed here.
  const supervise = canSeeHome({ role, isFlagEnabled: () => true, isCapabilityEnabled: () => true });
  const board = useHomeBoard({ tenantId, accountId, enabled: supervise, mode: 'live' });
  const today = useTodaySoFar(tenantId, accountId, supervise);
  const missed = useMissedCallsAccess();
  const key = homeAttentionKey(tenantId, accountId);

  const items = useMemo(
    () => homeAttention(board.reads, { available: missed.available, count: missed.count }, formatDate),
    [board.reads, missed.available, missed.count],
  );
  const needs = homeNeeds(items);
  const waiting = homeWaiting(items);
  const badgeCount = homeBadgeCount(items);
  const floor = useMemo(() => homeFloor(board.reads), [board.reads]);

  // The sidebar badge counts the same list (its dangers and warnings, not the missed calls the
  // Inbound badge carries). Published on every refresh, `refreshedAt` included, so the badge's
  // "fresh enough not to read again" holds while this page is open.
  useEffect(() => {
    if (key && board.status === 'ready') publishHomeAttentionCount(key, badgeCount);
  }, [key, board.status, badgeCount, board.refreshedAt]);

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  const canCreate = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  const running = board.reads.filter((r) => r.campaign.status === 'running').length;
  const onFloor = board.reads.reduce((n, r) => n + (r.stats?.agents_live ?? 0), 0);
  const noCampaigns = board.status === 'ready' && board.anyCampaign === false;
  const now = new Date();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          {accountName && <p className={styles.eyebrow}>{accountName}</p>}
          <h1 className={styles.title}>Home</h1>
          {board.status === 'ready' && !noCampaigns && (
            <p className={styles.subtitle} data-testid="home-summary">
              {`${plural(running, 'campaign')} running · ${plural(onFloor, 'agent')} on the floor`}
            </p>
          )}
        </div>
        {/* With no campaign at all the get-started card carries the button instead. */}
        {canCreate && !noCampaigns && (
          <Link to="/agency/campaigns/new" className={`btn-primary ${styles.headerAction}`}>
            <Plus size={16} aria-hidden="true" />
            New campaign
          </Link>
        )}
      </header>

      {/* The hook's copy (`HOME_BOARD_ERROR`), never the server's text. */}
      {board.status === 'error' && board.error && <ErrorAlert message={board.error} onRetry={board.reload} />}
      {(board.status === 'loading' || board.status === 'idle') && <LoadingSpinner />}

      {board.status === 'ready' && (
        <>
          <section className={styles.card} aria-labelledby="home-attention-heading">
            <div className={styles.cardHead}>
              <h2 id="home-attention-heading" className={styles.cardTitle}>
                Needs your attention
                {needs.length > 0 && <span className={styles.count}>{` · ${formatCount(needs.length)}`}</span>}
              </h2>
              <p className={styles.cardNote}>Each item clears itself once it’s fixed</p>
            </div>
            {needs.length > 0 ? (
              <ul className={styles.attentionList} data-testid="home-attention">
                {needs.map((item) => (
                  <AttentionRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            ) : (
              <p className={styles.allClear} data-testid="home-attention-empty">
                <CircleCheck size={18} aria-hidden="true" />
                Nothing needs you right now
              </p>
            )}
            {waiting.length > 0 && (
              <div className={styles.waiting} data-testid="home-waiting">
                <h3 className={styles.waitingTitle}>Waiting, nothing wrong</h3>
                <ul className={styles.attentionList}>
                  {waiting.map((item) => (
                    <AttentionRow key={item.id} item={item} now={now} />
                  ))}
                </ul>
              </div>
            )}
          </section>

          {noCampaigns ? (
            <GetStarted canCreate={canCreate} canInvite={hasPermission(role, 'user.invite')} />
          ) : (
            <section className={styles.card} aria-labelledby="home-floor-heading">
              <div className={styles.cardHead}>
                <h2 id="home-floor-heading" className={styles.cardTitle}>Floor right now</h2>
                <Link to="/agency/campaigns" className={styles.cardLink}>All campaigns</Link>
              </div>
              {floor.length > 0 ? (
                <>
                  <div className={styles.tableWrap}>
                    <table className={styles.table} data-testid="home-floor">
                      <thead>
                        <tr>
                          <th scope="col">Campaign</th>
                          <th scope="col" className={styles.num} title="Including agents a call is being connected to">On a call</th>
                          <th scope="col" className={styles.num}>Available</th>
                          <th scope="col" className={styles.num}>Wrapping up</th>
                          <th scope="col" className={styles.num}>On break</th>
                          <th scope="col" className={styles.num}>Abandonment (24h)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {floor.map((row) => (
                          <FloorRow key={row.campaign.id} row={row} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.cardNote}>Open a campaign to see who is where on its Agents tab.</p>
                </>
              ) : (
                <p className={styles.quiet} data-testid="home-floor-empty">
                  No campaign is running and nobody is on the floor.
                </p>
              )}
              {board.activeTotal > board.reads.length && (
                <p className={styles.cardNote} data-testid="home-cap-note">
                  {`Home reads the first ${HOME_CAMPAIGN_CAP} of ${formatCount(board.activeTotal)} active campaigns. The rest are on the Campaigns page.`}
                </p>
              )}
            </section>
          )}
        </>
      )}

      {/* Its own read, so it shows whatever became of the board's. */}
      <TodaySoFar today={today} />
    </div>
  );
}

function TodaySoFar({ today }: { today: ReturnType<typeof useTodaySoFar> }) {
  return (
    <section className={styles.card} aria-labelledby="home-today-heading">
      <div className={styles.cardHead}>
        <h2 id="home-today-heading" className={styles.cardTitle}>Today so far</h2>
        <Link to="/agency/analytics" className={styles.cardLink}>Open Reports</Link>
      </div>
      {today.status === 'loading' && <p className={styles.quiet}>Loading today’s numbers…</p>}
      {today.status === 'unavailable' && <p className={styles.quiet}>Today’s numbers didn’t load.</p>}
      {today.status === 'ready' && (
        <>
          <dl className={styles.tiles} data-testid="home-today">
            <Tile label="Dials" value={formatCount(today.totals.dials)} sub={`Across ${plural(today.totals.campaigns, 'campaign')}`} />
            <Tile label="Conversations" value={formatCount(today.totals.conversations)} />
            <Tile label="Successes" value={formatCount(today.totals.successes)} sub={todaySuccessLine(today.totals) ?? undefined} />
            <Tile label="Talk time" value={durationWords(today.totals.talkSeconds)} />
          </dl>
          <p className={styles.cardNote}>
            Since midnight your time, every campaign in this account. A success is a call whose outcome
            the campaign marks ‘Counts as a success’.
          </p>
        </>
      )}
    </section>
  );
}

function AttentionRow({ item, now }: { item: HomeAttentionItem; now: Date }) {
  return (
    <li className={styles.attentionRow} data-tone={item.tone} data-testid={`home-attention-${item.id}`}>
      <span className={`${styles.dot} ${styles[item.tone]}`} aria-hidden="true" />
      <div className={styles.attentionText}>
        {item.campaign && <span className={styles.campaignName}>{item.campaign.name}</span>}
        <span className={styles.attentionTitle}>{item.title}</span>
        <span className={styles.attentionDetail}>{item.detail}</span>
      </div>
      {item.at && <time className={styles.when} dateTime={item.at}>{when(item.at, now)}</time>}
      <Link to={item.to} className={`btn-secondary ${styles.action}`}>
        {item.action}
        <ChevronRight size={15} aria-hidden="true" />
      </Link>
    </li>
  );
}

function figure(value: number | null): string {
  return value === null ? '—' : formatCount(value);
}

function FloorRow({ row }: { row: HomeFloorRow }) {
  return (
    <tr>
      <th scope="row">
        <Link to={row.to} className={styles.floorName}>{row.campaign.name}</Link>
        <AgencyCampaignStatusBadge status={row.campaign.status} />
        {row.onCall === null && <span className={styles.quiet}>{` ${plural(row.agentsLive, 'agent')} live`}</span>}
      </th>
      <td className={styles.num}>{figure(row.onCall)}</td>
      <td className={styles.num}>{figure(row.available)}</td>
      <td className={styles.num}>{figure(row.wrapup)}</td>
      <td className={styles.num}>{figure(row.onBreak)}</td>
      <td className={styles.num}>
        <span className={`${styles.rate} ${row.abandonment.level ? styles[row.abandonment.level] : ''}`}>
          {row.abandonment.text}
        </span>
      </td>
    </tr>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.tile}>
      <dt className={styles.tileLabel}>{label}</dt>
      <dd className={styles.tileValue}>
        {value}
        {sub && <span className={styles.tileSub}>{sub}</span>}
      </dd>
    </div>
  );
}
