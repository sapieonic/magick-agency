import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Kpi } from '../../../components/common/Kpi';
import type { HomeBoard } from '../../../hooks/useHomeBoard';
import type { TodayState } from '../../../hooks/useTodaySoFar';
import { todaySuccessLine, type HomeCampaignRead } from '../../../utils/agency/home';
import {
  agentsWorking,
  agentsWorkingSub,
  answeredLine,
  lateCallbacks,
  lateCallbacksText,
  todayFor,
  type AgentsWorking,
} from '../../../utils/agency/liveFloor';
import { CALLBACKS_PATH } from '../../../utils/consoleNav';
import { formatCount } from '../../../utils/format/number';
import styles from './LiveFloor.module.css';

/** One tile's figures, for a tile a later phase supplies (`outcome`). */
export interface LiveFloorTile {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId?: string;
}

const DASH = '—';

/**
 * The five tiles. The board's (agents working, late callbacks) need the board; today's (calls,
 * customers reached, successes) need Today so far, which is its own read and shows whatever became
 * of the board's. With a campaign picked, every tile is that campaign's.
 *
 * Seams for Phase 2: `agents` replaces the board's sum with the floor read's figure (its
 * `assigned` turns the line into "of N assigned"), and `outcome` replaces the Successes tile (with
 * "Will pay" once the account records promises). Each is one prop; nothing else changes.
 */
export function LiveFloorKpis({
  board,
  reads,
  today,
  campaignId,
  agents,
  outcome,
  partial = false,
}: {
  board: Pick<HomeBoard, 'status'>;
  reads: readonly HomeCampaignRead[];
  today: TodayState;
  campaignId: string | null;
  agents?: AgentsWorking;
  outcome?: LiveFloorTile;
  /** The board left active campaigns out (its cap): an account-wide late count is a lower bound. */
  partial?: boolean;
}) {
  const boardReady = board.status === 'ready';
  const working = agents ?? agentsWorking(reads);
  // The floor read's figure stands on its own; the board's sum needs the board.
  const workingKnown = agents !== undefined || boardReady;
  const late = boardReady ? lateCallbacks(reads) : null;
  // One campaign picked is one campaign's whole figure; the account's past the cap is "4+".
  const lateText = late === null ? DASH : lateCallbacksText(late, partial && campaignId === null);
  const lateBound = partial && campaignId === null;
  const figures = today.status === 'ready' ? todayFor(today.totals, today.byCampaign, campaignId) : null;
  const pending = today.status === 'loading' ? '…' : DASH;

  return (
    <section aria-label="Today at a glance" className={styles.kpiSection}>
      <div className={styles.kpis} data-testid="home-today">
        <Kpi
          look="outlined"
          label="Agents working"
          value={workingKnown ? formatCount(working.working) : DASH}
          sub={workingKnown ? agentsWorkingSub(working) : undefined}
          testId="kpi-agents"
        />
        <Kpi
          look="outlined"
          label="Calls today"
          value={figures ? formatCount(figures.dials) : pending}
          sub="dialled since midnight"
          testId="kpi-calls"
        />
        <Kpi
          look="outlined"
          label="Customers reached"
          value={figures ? formatCount(figures.conversations) : pending}
          sub={figures ? answeredLine(figures) : undefined}
          testId="kpi-reached"
        />
        {outcome ? (
          <Kpi look="outlined" label={outcome.label} value={outcome.value} sub={outcome.sub} testId={outcome.testId ?? 'kpi-outcome'} />
        ) : (
          <Kpi
            look="outlined"
            label="Successes"
            value={figures ? formatCount(figures.successes) : pending}
            sub={figures ? todaySuccessLine(figures) : undefined}
            testId="kpi-outcome"
          />
        )}
        <Link
          to={CALLBACKS_PATH}
          className={styles.kpiLink}
          data-testid="kpi-late-callbacks"
          aria-label={`Late callbacks: ${late === null ? 'not known' : `${lateBound ? 'at least ' : ''}${formatCount(late)}`}. Open Callbacks`}
        >
          <Kpi
            look="outlined"
            label="Late callbacks"
            value={lateText}
            sub={lateBound ? 'in the first 25 active campaigns' : 'promised time has passed'}
            tone={late !== null && late > 0 ? 'danger' : undefined}
          />
        </Link>
      </div>
      {today.status === 'unavailable' ? (
        <p className={styles.cardNote}>Today’s numbers didn’t load.</p>
      ) : (
        <p className={styles.cardNote}>
          {campaignId ? 'Since midnight your time, this campaign. ' : 'Since midnight your time, every campaign in this account. '}
          A success is a call whose outcome the campaign marks ‘Counts as a success’.{' '}
          <Link to="/agency/analytics" className={styles.cardLink}>Open Analytics</Link>
        </p>
      )}
    </section>
  );
}
