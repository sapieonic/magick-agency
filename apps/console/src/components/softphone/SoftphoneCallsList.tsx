import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Calendar, ListChecks, Phone, Play, Search } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { FiltersCard } from '../agency/FiltersCard';
import { useTenant } from '../../contexts/TenantContext';
import { getSoftphoneBootstrap, listManualCalls } from '../../api/softphone';
import { listTenantMembers } from '../../api/tenants';
import { formatSpineTimestamp, formatTalkTime } from '../../utils/agencySpineCopy';
import { agentInitials } from '../../utils/agencyAgentRoster';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { catalogForCall, loggedToLabel, manualCallOutcome } from '../../utils/softphone/callLabels';
import {
  EMPTY_SOFTPHONE_CALLS_DRAFT,
  activeFilterCount,
  queryFromDraft,
  summariseCalls,
  todayLocal,
  type SoftphoneCallsDraft,
} from '../../utils/softphone/callStats';
import { formatCount } from '../../utils/format/number';
import { ATTEMPT_OUTCOME_LABELS } from '../../types/agency-spine';
import { AGENCY_MANUAL_CALL_OUTCOMES, type AgencyManualCall, type AgencySoftphoneBootstrap } from '../../types/softphone';
import spine from '../agency/SpineListLayout.module.css';
import styles from './SoftphoneCallsList.module.css';

const PAGE_SIZE = 50;

export interface SoftphoneCallsListProps {
  /** `account`: every agent's calls (`agency.supervise`); `me`: the caller's own. */
  scope: 'account' | 'me';
  /** The signed-in user, so `me` asks for exactly their rows whatever their role. */
  userId?: string | null;
  /** Fixed tag filter — a campaign's own Manual calls view. */
  campaignId?: string;
  /** Where a row opens, or null for no link. */
  detailPath?: (call: AgencyManualCall) => string | null;
  /** Initial date range: today, as the supervisor's list opens. */
  defaultToday?: boolean;
  caption: string;
}

/**
 * The soft-phone calls list: stats strip, filters, keyset paging, one row per
 * manual call. One component for the supervisor's account-wide list, a
 * campaign's Manual calls view and the agent's My calls tab, so the three cannot
 * drift apart in what a row says.
 *
 * Names come from the soft phone's bootstrap — the taggable campaigns with their
 * outcome catalogs and the untagged catalog — so an outcome code is read against
 * the catalog it was saved against (`disposition_source`), and the "Logged to"
 * filter lists exactly the campaigns a call can be logged to.
 */
export function SoftphoneCallsList({
  scope,
  userId = null,
  campaignId,
  detailPath,
  defaultToday = false,
  caption,
}: SoftphoneCallsListProps) {
  const { tenantId, accountId } = useTenant();
  const initialDraft: SoftphoneCallsDraft = defaultToday
    ? { ...EMPTY_SOFTPHONE_CALLS_DRAFT, from: todayLocal(), to: todayLocal() }
    : EMPTY_SOFTPHONE_CALLS_DRAFT;
  const [draft, setDraft] = useState<SoftphoneCallsDraft>(initialDraft);
  const [applied, setApplied] = useState<SoftphoneCallsDraft>(initialDraft);
  const [rows, setRows] = useState<AgencyManualCall[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<AgencySoftphoneBootstrap | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const seq = useRef(0);

  const fixed = useMemo(
    () => ({
      ...(campaignId ? { campaignId } : {}),
      ...(scope === 'me' && userId ? { agentUserId: userId } : {}),
    }),
    [campaignId, scope, userId],
  );

  useEffect(() => {
    if (!tenantId || !accountId) return;
    getSoftphoneBootstrap(tenantId, accountId)
      .then(setBootstrap)
      // Names are a courtesy on top of the calls: without them a code reads as itself.
      .catch(() => setBootstrap(null));
  }, [tenantId, accountId]);

  useEffect(() => {
    if (scope !== 'account' || !tenantId) return;
    listTenantMembers(tenantId)
      .then((members) => {
        const list = (members ?? [])
          .map((m) => ({ id: m.user.id, name: m.user.display_name ?? m.user.email }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setAgents(list);
      })
      .catch(() => setAgents([]));
  }, [scope, tenantId]);

  const load = useCallback(
    async (filters: SoftphoneCallsDraft) => {
      if (!tenantId || !accountId) return;
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      setMoreError(null);
      try {
        const page = await listManualCalls({ ...queryFromDraft(filters, fixed), limit: PAGE_SIZE }, tenantId, accountId);
        if (mine !== seq.current) return;
        setRows(page.rows);
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (mine !== seq.current) return;
        setError(getErrorMessage(err, 'We couldn’t load the soft-phone calls.'));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [tenantId, accountId, fixed],
  );

  useEffect(() => {
    void load(applied);
  }, [load, applied]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || !tenantId || !accountId) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listManualCalls(
        { ...queryFromDraft(applied, fixed), cursor: nextCursor, limit: PAGE_SIZE },
        tenantId,
        accountId,
      );
      // A filter change mid-request: these rows answer a different question.
      if (mine !== seq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (mine === seq.current) setMoreError(getErrorMessage(err, 'We couldn’t load older calls.'));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, tenantId, accountId, applied, fixed]);

  // Agents seen in the rows join the team list, so a filter never lacks someone on screen.
  const agentOptions = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a.name]));
    for (const row of rows) if (!byId.has(row.agent_user_id) && row.agent_name) byId.set(row.agent_user_id, row.agent_name);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, rows]);

  const stats = useMemo(() => summariseCalls(rows), [rows]);
  const invertedRange = Boolean(draft.from && draft.to && draft.from > draft.to);
  const active = activeFilterCount(applied, Boolean(campaignId), scope === 'me');
  const filtered = active > 0;
  const showAgent = scope === 'account';
  const set = (patch: Partial<SoftphoneCallsDraft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <div data-testid="softphone-calls-list">
      <div className={styles.stats} aria-label="Summary of the calls listed" role="group">
        <Stat label="Calls" value={formatCount(stats.calls)} />
        <Stat label="Connected" value={formatCount(stats.connected)} />
        <Stat label="Avg talk" value={stats.avgTalkSeconds === null ? '—' : formatTalkTime(stats.avgTalkSeconds)} mono />
        {campaignId ? null : <Stat label="Not logged to a campaign" value={formatCount(stats.notLogged)} />}
        <Stat
          label="Waiting for an outcome"
          value={formatCount(stats.awaitingOutcome)}
          tone={stats.awaitingOutcome > 0 ? 'warning' : undefined}
        />
      </div>
      <p className={styles.statsNote} data-testid="softphone-stats-note">
        {loading
          ? 'Counting…'
          : `Across the ${formatCount(stats.calls)} call${stats.calls === 1 ? '' : 's'} listed below${
              nextCursor ? ' — load older calls to include them' : ''
            }.`}
      </p>

      <FiltersCard activeCount={active}>
        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>From date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draft.from}
                onChange={(e) => set({ from: e.target.value })}
                data-testid="filter-from"
              />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>To date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draft.to}
                onChange={(e) => set({ to: e.target.value })}
                data-testid="filter-to"
              />
            </span>
          </label>
          {showAgent ? (
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Agent</span>
              <select
                className={styles.select}
                value={draft.agentUserId}
                onChange={(e) => set({ agentUserId: e.target.value })}
                data-testid="filter-agent"
              >
                <option value="">All agents</option>
                {agentOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {campaignId ? null : (
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Logged to</span>
              <select
                className={styles.select}
                value={draft.campaignId}
                onChange={(e) => set({ campaignId: e.target.value })}
                data-testid="filter-campaign"
              >
                <option value="">Any</option>
                <option value="untagged">Not logged to a campaign</option>
                {(bootstrap?.taggable_campaigns ?? []).map((c) => (
                  <option key={c.campaign_id} value={c.campaign_id}>
                    {c.campaign_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={spine.field}>
            <span className={spine.fieldLabel}>What happened</span>
            <select
              className={styles.select}
              value={draft.outcome}
              onChange={(e) => set({ outcome: e.target.value })}
              data-testid="filter-outcome"
            >
              <option value="">Any</option>
              {AGENCY_MANUAL_CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {ATTEMPT_OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Phone number</span>
            <span className={spine.inputWrap}>
              <Search size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="text"
                inputMode="tel"
                className={spine.fieldInput}
                value={draft.phone}
                placeholder="Whole number, or the last few digits"
                onChange={(e) => set({ phone: e.target.value })}
                data-testid="filter-phone"
              />
            </span>
          </label>
        </div>
        <div className={spine.filterFooter}>
          {invertedRange ? (
            <p className={spine.filterError} role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              The “From” date is after the “To” date, so nothing could match. Swap them to continue.
            </p>
          ) : null}
          <div className={spine.filterActions}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setApplied(draft)}
              disabled={invertedRange}
              data-testid="filter-apply"
            >
              Apply
            </button>
            {filtered ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDraft(EMPTY_SOFTPHONE_CALLS_DRAFT);
                  setApplied(EMPTY_SOFTPHONE_CALLS_DRAFT);
                }}
                data-testid="filter-clear"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </FiltersCard>

      {error ? <ErrorAlert message={error} onRetry={() => void load(applied)} /> : null}

      <p className={spine.count} aria-live="polite" aria-atomic="true" data-testid="softphone-calls-count">
        {!loading && rows.length > 0 ? (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {`Showing ${formatCount(rows.length)} call${rows.length === 1 ? '' : 's'}${nextCursor ? ' — there are more' : ''}`}
          </>
        ) : null}
      </p>

      {loading ? <LoadingSpinner /> : null}

      {!loading && !error && rows.length === 0 ? (
        <EmptyState
          icon={<Phone size={32} />}
          title={filtered ? 'Nothing matches those filters' : 'No soft-phone calls yet'}
          description={
            filtered
              ? 'Widen the date range or clear the filters to see every call.'
              : 'Calls placed from the soft phone appear here as they are made.'
          }
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>{caption}</caption>
              <thead>
                <tr>
                  <th>When</th>
                  {showAgent ? <th>Agent</th> : null}
                  <th>Number</th>
                  {campaignId ? null : <th>Logged to</th>}
                  <th>Outcome</th>
                  <th>Talk</th>
                  {detailPath ? <th>Call</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((call) => {
                  const outcome = manualCallOutcome(call, catalogForCall(call, bootstrap));
                  const path = detailPath?.(call) ?? null;
                  const name = call.agent_name ?? 'Former member';
                  return (
                    <tr key={call.id} data-testid={`softphone-row-${call.id}`}>
                      <td className={styles.when}>{formatSpineTimestamp(call.created_at)}</td>
                      {showAgent ? (
                        <td>
                          <span className={styles.agent}>
                            <span className={styles.avatar} aria-hidden="true">
                              {agentInitials(name)}
                            </span>
                            {name}
                          </span>
                        </td>
                      ) : null}
                      <td className={styles.mono}>{formatDialNumber(call.destination_e164)}</td>
                      {campaignId ? null : (
                        <td className={call.tag ? undefined : styles.muted}>{loggedToLabel(call)}</td>
                      )}
                      <td>
                        <span className={styles.outcome} data-kind={outcome.kind}>
                          {outcome.text}
                        </span>
                        {call.dnc_overridden || call.hours_overridden ? (
                          <span className={styles.badges}>
                            {call.dnc_overridden ? (
                              <span className={styles.badge} title="Called through a Do Not Call entry, with a note">
                                DNC override
                              </span>
                            ) : null}
                            {call.hours_overridden ? (
                              <span className={styles.badge} title="Called outside calling hours, with a note">
                                Hours override
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </td>
                      <td className={styles.mono}>{formatTalkTime(call.talk_seconds)}</td>
                      {detailPath ? (
                        <td>
                          {path ? (
                            <Link to={path} className={styles.openLink} aria-label={`Open the call to ${formatDialNumber(call.destination_e164)}`}>
                              <Play size={13} aria-hidden="true" />
                              Open call
                            </Link>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {moreError ? <p className="error-text">{moreError}</p> : null}
          {nextCursor ? (
            <div className={spine.more}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="softphone-load-more"
              >
                {loadingMore ? 'Loading…' : 'Load older calls'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'warning' }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${mono ? styles.mono : ''}`} data-tone={tone}>
        {value}
      </span>
    </div>
  );
}
