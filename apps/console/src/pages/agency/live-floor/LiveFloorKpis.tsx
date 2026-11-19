import { Link } from 'react-router-dom';
import { Kpi } from '../../../components/common/Kpi';
import type { HomeBoard } from '../../../hooks/useHomeBoard';
import type { TodayState } from '../../../hooks/useTodaySoFar';
import { HOME_CAMPAIGN_CAP, todaySuccessLine, type HomeCampaignRead } from '../../../utils/agency/home';
import {
  agentsWorking,
  agentsWorkingSub,
  answeredLine,
  lateCallbacksFigure,
  lateCallbacksText,
  todayFor,
  type AgentsWorking,
} from '../../../utils/agency/liveFloor';
import { willPayLine, type WillPay } from '../../../utils/agency/liveFloorAgents';
import { CALLBACKS_PATH } from '../../../utils/consoleNav';
import { formatCount } from '../../../utils/format/number';
import styles from './LiveFloor.module.css';

const DASH = '—';

/**
 * The five tiles. The board's (agents working, late callbacks) need the board; today's (calls,
 * customers reached, successes) need Today so far, which is its own read and shows whatever became
 * of the board's. With a campaign picked, every tile is that campaign's.
 *
 * Phase 2's reads: `agents` replaces the board's sum with the floor read's figure (its
 * `assigned` turns the line into "of N assigned"), and `willPay` (the promises summary over the
 * shown campaigns, `willPayFor`) makes the Successes tile Will pay while a shown campaign records
 * promises. Late callbacks are `lateCallbacksFigure`'s, as on the Callbacks page and the badge.
 */
export function LiveFloorKpis({
  board,
  reads,
  today,
  campaignId,
  agents,
  willPay = null,
}: {
  board: Pick<HomeBoard, 'status' | 'activeTotal' | 'reads'>;
  /** The shown campaigns' reads (`readsFor`): every board read, or the one campaign picked. */
  reads: readonly HomeCampaignRead[];
  today: TodayState;
  campaignId: string | null;
  agents?: AgentsWorking;
  /** Will pay over the shown campaigns, or null (Successes then). */
  willPay?: WillPay | null;
}) {
  const boardReady = board.status === 'ready';
  const working = agents ?? agentsWorking(reads);
  // The floor read's figure stands on its own; the board's sum needs the board.
  const workingKnown = agents !== undefined || boardReady;
  // "4+" past the board's cap (the account's figure only) or with a campaign not known; never a plain 0 it did not read.
  const lateFigure = boardReady ? lateCallbacksFigure(board, campaignId) : null;
  const late = lateFigure?.count ?? null;
  const capped = lateFigure?.capped ?? false;
  const lateBound = lateFigure?.lowerBound ?? false;
  const lateText = late === null ? DASH : lateCallbacksText(late, lateBound);
  const lateSaid = late === null
    ? 'not known'
    : lateBound ? (late === 0 ? 'none found in the campaigns read' : `at least ${formatCount(late)}`) : formatCount(late);
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
        {willPay ? (
          <Kpi look="outlined" label="Will pay" value={formatCount(willPay.promises)} sub={willPayLine(willPay)} testId="kpi-outcome" />
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
          aria-label={`Late callbacks: ${lateSaid}. Open Callbacks`}
        >
          <Kpi
            look="outlined"
            label="Late callbacks"
            value={lateText}
            sub={capped ? `in the first ${HOME_CAMPAIGN_CAP} active campaigns` : lateBound ? 'some campaigns not read' : 'promised time has passed'}
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
