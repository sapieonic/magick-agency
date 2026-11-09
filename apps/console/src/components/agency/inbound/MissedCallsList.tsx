import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calendar, Check, ListChecks, Phone, PhoneIncoming } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { FiltersCard } from '../FiltersCard';
import { useTenant } from '../../../contexts/TenantContext';
import { listMissedInboundCalls, markMissedInboundCallHandled } from '../../../api/inbound';
import { listTenantMembers } from '../../../api/tenants';
import { formatSpineTimestamp } from '../../../utils/agencySpineCopy';
import { formatDialNumber } from '../../../utils/softphone/phoneInput';
import { softphonePrefillState } from '../../../utils/softphone/prefill';
import {
  EMPTY_MISSED_FILTERS,
  MISSED_REASON_LABELS,
  assigneeLabel,
  inboundRefusalCopy,
  missedQueryFromDraft,
  type MissedFiltersDraft,
} from '../../../utils/inbound/inboundCopy';
import { AGENCY_INBOUND_MISSED_REASONS, type AgencyInboundMissedCall } from '../../../types/inbound';
import spine from '../SpineListLayout.module.css';
import styles from './Inbound.module.css';

const PAGE_SIZE = 50;

export interface MissedCallsListProps {
  /** The signed-in user: "You" on their rows. */
  userId: string | null;
  /** `agency.supervise`: the account's rows, and the assignee filter. Without it, the caller's own (the server's rule too). */
  supervise: boolean;
  /** The soft phone is on and the caller may dial: Call back opens it with the number on the pad. */
  canCallBack: boolean;
}

/**
 * The Missed calls list (`docs/inbound.md` §7): inbound calls that reached nobody, newest first,
 * Open or Handled, with filters (reason, dates; for a supervisor, who it is assigned to) and keyset
 * paging. Each open row offers **Call back** — the soft phone with the caller's number on the pad
 * and the matched campaign as its "Log to" (nothing is dialled until the agent presses Call, and
 * a caller on a DNC list meets the soft phone's own DNC check and override note) — and **Mark
 * handled**, which the server makes idempotent.
 */
export function MissedCallsList({ userId, supervise, canCallBack }: MissedCallsListProps) {
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<MissedFiltersDraft>(EMPTY_MISSED_FILTERS);
  const [applied, setApplied] = useState<MissedFiltersDraft>(EMPTY_MISSED_FILTERS);
  const [rows, setRows] = useState<AgencyInboundMissedCall[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!supervise || !tenantId) return;
    listTenantMembers(tenantId)
      .then((list) =>
        setMembers(
          (list ?? [])
            .map((m) => ({ id: m.user.id, name: m.user.display_name ?? m.user.email }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      )
      // The names are a courtesy: without them the filter offers "me" and "nobody".
      .catch(() => setMembers([]));
  }, [supervise, tenantId]);

  const load = useCallback(
    async (filters: MissedFiltersDraft) => {
      if (!tenantId || !accountId) return;
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      setMoreError(null);
      try {
        const page = await listMissedInboundCalls({ ...missedQueryFromDraft(filters), limit: PAGE_SIZE }, tenantId, accountId);
        if (mine !== seq.current) return;
        setRows(page.rows);
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (mine !== seq.current) return;
        setError(getErrorMessage(err, 'We couldn’t load the missed calls.'));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [tenantId, accountId],
  );

  useEffect(() => {
    void load(applied);
  }, [load, applied]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore || !tenantId || !accountId) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listMissedInboundCalls(
        { ...missedQueryFromDraft(applied), cursor: nextCursor, limit: PAGE_SIZE },
        tenantId,
        accountId,
      );
      if (mine !== seq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (mine === seq.current) setMoreError(getErrorMessage(err, 'We couldn’t load older missed calls.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const markHandled = async (call: AgencyInboundMissedCall) => {
    if (marking) return;
    setMarking(call.id);
    setRowError(null);
    const result = await markMissedInboundCallHandled(call.id, tenantId ?? undefined, accountId ?? undefined);
    setMarking(null);
    if (!result.ok) {
      setRowError({ id: call.id, message: inboundRefusalCopy(result.refusal) });
      return;
    }
    // Off the Open list, onto the Handled one: the row leaves the view it no longer matches.
    setRows((current) =>
      applied.status === 'open'
        ? current.filter((r) => r.id !== call.id)
        : current.map((r) => (r.id === call.id ? result.value : r)),
    );
    setAnnouncement(`Marked the call from ${callerLabel(call)} as handled.`);
  };

  const callBack = (call: AgencyInboundMissedCall) => {
    if (!call.from_e164) return;
    navigate('/dialer/phone', {
      state: softphonePrefillState({ number: call.from_e164, campaignId: call.matched_campaign_id }),
    });
  };

  const invertedRange = Boolean(draft.from && draft.to && draft.from > draft.to);
  const active = [applied.reason, applied.from, applied.to, supervise ? applied.assignee : ''].filter(Boolean).length;
  const set = (patch: Partial<MissedFiltersDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setStatus = (status: MissedFiltersDraft['status']) => {
    setDraft((current) => ({ ...current, status }));
    setApplied((current) => ({ ...current, status }));
  };
  const open = applied.status === 'open';

  return (
    <div className={styles.page} data-testid="missed-calls-list">
      <div className={styles.tabs} role="tablist" aria-label="Which missed calls">
        {(['open', 'handled'] as const).map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={applied.status === status}
            aria-controls="missed-calls-panel"
            onClick={() => setStatus(status)}
            data-testid={`missed-tab-${status}`}
          >
            {status === 'open' ? 'To follow up' : 'Handled'}
          </button>
        ))}
      </div>

      <FiltersCard activeCount={active}>
        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>From date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input type="date" className={spine.fieldInput} value={draft.from} onChange={(e) => set({ from: e.target.value })} data-testid="missed-filter-from" />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>To date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input type="date" className={spine.fieldInput} value={draft.to} onChange={(e) => set({ to: e.target.value })} data-testid="missed-filter-to" />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Why it was missed</span>
            <select
              className={styles.select}
              value={draft.reason}
              onChange={(e) => set({ reason: e.target.value as MissedFiltersDraft['reason'] })}
              data-testid="missed-filter-reason"
            >
              <option value="">Any reason</option>
              {AGENCY_INBOUND_MISSED_REASONS.map((r) => (
                <option key={r} value={r}>
                  {MISSED_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {supervise ? (
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Assigned to</span>
              <select
                className={styles.select}
                value={draft.assignee}
                onChange={(e) => set({ assignee: e.target.value })}
                data-testid="missed-filter-assignee"
              >
                <option value="">Anyone</option>
                <option value="me">Me</option>
                <option value="unassigned">The account (no one in particular)</option>
                {members.filter((m) => m.id !== userId).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className={spine.filterFooter}>
          {invertedRange ? (
            <p className={spine.filterError} role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              The “From” date is after the “To” date, so nothing could match. Swap them to continue.
            </p>
          ) : null}
          <div className={spine.filterActions}>
            <button type="button" className="btn-primary" onClick={() => setApplied(draft)} disabled={invertedRange} data-testid="missed-filter-apply">
              Apply
            </button>
            {active > 0 ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  const cleared = { ...EMPTY_MISSED_FILTERS, status: applied.status };
                  setDraft(cleared);
                  setApplied(cleared);
                }}
                data-testid="missed-filter-clear"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </FiltersCard>

      <p className={styles.srOnly} aria-live="polite" role="status">
        {announcement}
      </p>
      {error ? <ErrorAlert message={error} onRetry={() => void load(applied)} /> : null}

      <p className={spine.count} aria-live="polite" aria-atomic="true">
        {!loading && rows.length > 0 ? (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {`Showing ${rows.length} call${rows.length === 1 ? '' : 's'}${nextCursor ? ' — there are more' : ''}`}
          </>
        ) : null}
      </p>

      {loading ? <LoadingSpinner /> : null}

      {!loading && !error && rows.length === 0 ? (
        <EmptyState
          icon={<PhoneIncoming size={32} />}
          title={active > 0 ? 'Nothing matches those filters' : open ? 'No missed calls to follow up' : 'No handled missed calls'}
          description={
            active > 0
              ? 'Widen the dates or clear the filters.'
              : open
                ? supervise
                  ? 'When a customer rings and nobody answers, the call appears here for someone to call them back.'
                  : 'When one of your customers rings and nobody answers, the call appears here for you to call them back.'
                : 'Calls marked handled appear here.'
          }
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <div id="missed-calls-panel" role="tabpanel">
          <div className={spine.tableWrap}>
            <table className={`${spine.table} ${styles.stackTable}`}>
              <caption className={styles.srOnly}>
                {open ? 'Missed calls to follow up, newest first' : 'Handled missed calls, newest first'}
              </caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Caller</th>
                  <th>Why it was missed</th>
                  <th>Campaign</th>
                  {supervise ? <th>Assigned to</th> : null}
                  <th>{open ? 'Follow up' : 'Handled'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((call) => (
                  <tr key={call.id} data-testid={`missed-row-${call.id}`}>
                    <td className={styles.when} data-label="When">{formatSpineTimestamp(call.arrived_at)}</td>
                    <td data-label="Caller">
                      {call.from_e164 ? (
                        <span className={styles.mono}>{formatDialNumber(call.from_e164)}</span>
                      ) : (
                        <span className={styles.muted}>Number withheld</span>
                      )}
                      {call.caller_dnc ? (
                        <span
                          className={styles.badge}
                          title="This number is on a Do Not Call list. The soft phone asks for a reason before calling it."
                          data-testid="missed-dnc"
                        >
                          DNC
                        </span>
                      ) : null}
                      <span className={styles.sub}>
                        Rang {formatDialNumber(call.to_e164)}
                        {call.route_name ? ` · ${call.route_name}` : ''}
                      </span>
                    </td>
                    <td data-label="Why it was missed">
                      <span className={styles.reason}>{MISSED_REASON_LABELS[call.reason]}</span>
                      {call.has_voicemail ? <span className={styles.sub}>Left a voicemail</span> : null}
                    </td>
                    <td data-label="Campaign">
                      {call.matched_campaign_name ?? <span className={styles.muted}>Not matched</span>}
                      {call.callback_due_at ? (
                        <span className={styles.sub}>Callback booked for {formatSpineTimestamp(call.callback_due_at)}</span>
                      ) : null}
                    </td>
                    {supervise ? <td data-label="Assigned to">{assigneeLabel(call, userId)}</td> : null}
                    <td data-label={open ? 'Follow up' : 'Handled'}>
                      {call.status === 'handled' ? (
                        <span>
                          {call.handled_by_user_id === userId ? 'You' : (call.handled_by_name ?? (call.handled_by_user_id ? 'Former member' : 'Closed automatically'))}
                          <span className={styles.sub}>{formatSpineTimestamp(call.handled_at)}</span>
                        </span>
                      ) : (
                        <div className={styles.rowActions}>
                          {canCallBack ? (
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => callBack(call)}
                              disabled={!call.from_e164}
                              title={call.from_e164 ? undefined : 'The caller withheld their number.'}
                              aria-label={call.from_e164 ? `Call back ${formatDialNumber(call.from_e164)}` : 'Call back (number withheld)'}
                              data-testid="missed-call-back"
                            >
                              <Phone size={13} aria-hidden="true" />
                              Call back
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => void markHandled(call)}
                            disabled={marking !== null}
                            aria-label={`Mark the call from ${callerLabel(call)} as handled`}
                            data-testid="missed-mark-handled"
                          >
                            <Check size={13} aria-hidden="true" />
                            {marking === call.id ? 'Marking…' : 'Mark handled'}
                          </button>
                          {rowError?.id === call.id ? (
                            <p className="error-text" role="alert">
                              {rowError.message}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreError ? <p className="error-text">{moreError}</p> : null}
          {nextCursor ? (
            <div className={spine.more}>
              <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore} data-testid="missed-load-more">
                {loadingMore ? 'Loading…' : 'Load older calls'}
              </button>
            </div>
          ) : null}
          {open && !canCallBack ? (
            <p className={styles.note} data-testid="missed-no-softphone">
              Call back opens the soft phone, which isn’t on for this account. Call the customer another way, then mark the call handled.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function callerLabel(call: AgencyInboundMissedCall): string {
  return call.from_e164 ? formatDialNumber(call.from_e164) : 'a withheld number';
}
