import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calendar, Check, ListChecks, Phone, PhoneIncoming, RotateCcw, UserPlus, UserRoundPen } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { FiltersCard } from '../FiltersCard';
import { VoicemailPlayer } from './VoicemailPlayer';
import { useTenant } from '../../../contexts/TenantContext';
import {
  assignMissedInboundCall,
  claimMissedInboundCall,
  listMissedInboundCalls,
  markMissedInboundCallHandled,
  reopenMissedInboundCall,
  type InboundRefusal,
  type InboundResult,
} from '../../../api/inbound';
import { refreshMissedCallsCount } from '../../../hooks/useMissedCallsCount';
import { listTenantMembers } from '../../../api/tenants';
import { formatSpineTimestamp } from '../../../utils/agencySpineCopy';
import { formatDialNumber } from '../../../utils/softphone/phoneInput';
import { softphonePrefillState } from '../../../utils/softphone/prefill';
import {
  EMPTY_MISSED_FILTERS,
  MISSED_REASON_LABELS,
  inboundRefusalCopy,
  missedQueryFromDraft,
  type MissedFiltersDraft,
} from '../../../utils/inbound/inboundCopy';
import {
  MISSED_REACHED_NOTE,
  MISSED_TEAM_COPY,
  claimRefusalCopy,
  claimedNotice,
  departedAssigneeNote,
  missedCallerLabel,
  missedCallerName,
  missedAssigneeLabel,
  missedHandledLabel,
  missedReasonLabel,
  reassignRefusalCopy,
  reopenRefusalCopy,
} from '../../../utils/inbound/missedCopy';
import {
  AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED,
  AGENCY_INBOUND_MISSED_REASONS,
  type AgencyInboundMissedCall,
  type AgencyInboundMissedListQuery,
} from '../../../types/inbound';
import spine from '../SpineListLayout.module.css';
import styles from './Inbound.module.css';
import missedStyles from './MissedCalls.module.css';

const PAGE_SIZE = 50;

/** An agent's two views (IQ49): their own rows, or the account's unassigned ones to claim. */
export type MissedView = 'mine' | 'team';

/**
 * The page's query for the filters and the view. The Team view is the account's open rows nobody
 * has (`assignee=unassigned`), whatever the status tab said; the agent's own view is the server's
 * default for them.
 */
export function missedListQuery(filters: MissedFiltersDraft, view: MissedView): AgencyInboundMissedListQuery {
  if (view === 'team') {
    return missedQueryFromDraft({ ...filters, status: 'open', assignee: AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED });
  }
  return missedQueryFromDraft(filters);
}

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
 * handled**, which the server makes idempotent. A row also closes on its own once the customer is
 * reached by an agent of the account (`reached`, shown on the Handled tab). A handled row offers
 * **Reopen**, which puts it back on the list (a row marked by mistake, or closed as reached when
 * the customer was not).
 *
 * A supervisor **reassigns** an open row to a member of the account, or to the account; a row
 * whose assignee has left reads "Former member" with the prompt to reassign it. Every change
 * re-reads the nav badge's count.
 *
 * Without `agency.supervise` the list has two views (IQ49): **Yours** (the agent's own rows, as
 * above) and **Team**, the account's open rows nobody has, each with **Claim**: the row becomes
 * theirs and leaves the Team view for their own (a compare-and-set on the server; someone quicker
 * is said in words on the row). A supervisor keeps the account's whole list, the same rows under
 * "Assigned to: The account (no one in particular)".
 *
 * A row whose caller was matched to a contact shows the contact's name above the number (IQ54).
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
  const [reopening, setReopening] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [members, setMembers] = useState<Array<{ id: string; name: string; assignable: boolean }>>([]);
  /** The row whose reassign picker is open, and what is picked ('' : the account). */
  const [reassigning, setReassigning] = useState<{ id: string; to: string } | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  /** Agents only: their own rows, or the Team view (supervisors always read the account's). */
  const [view, setView] = useState<MissedView>('mine');
  const [claiming, setClaiming] = useState<string | null>(null);
  /** The Team view's last claim, said where the row was: it has moved to the agent's own list. */
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const seq = useRef(0);
  const effectiveView: MissedView = supervise ? 'mine' : view;
  const team = effectiveView === 'team';

  useEffect(() => {
    if (!supervise || !tenantId) return;
    listTenantMembers(tenantId)
      .then((list) => {
        // One entry per person: a member at tenant level and in this account is one choice.
        const byId = new Map<string, { id: string; name: string; assignable: boolean }>();
        for (const m of list ?? []) {
          const assignable = m.membership.status === 'active'
            && (m.membership.account_id === null || m.membership.account_id === accountId);
          const prior = byId.get(m.user.id);
          byId.set(m.user.id, {
            id: m.user.id,
            name: m.user.display_name ?? m.user.email,
            assignable: assignable || (prior?.assignable ?? false),
          });
        }
        setMembers([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      // The names are a courtesy: without them the filter offers "me" and "nobody", and a
      // reassign offers the account only.
      .catch(() => setMembers([]));
  }, [supervise, tenantId, accountId]);

  const load = useCallback(
    async (filters: MissedFiltersDraft, which: MissedView) => {
      if (!tenantId || !accountId) return;
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      setMoreError(null);
      try {
        const page = await listMissedInboundCalls({ ...missedListQuery(filters, which), limit: PAGE_SIZE }, tenantId, accountId);
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
    void load(applied, effectiveView);
  }, [load, applied, effectiveView]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore || !tenantId || !accountId) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listMissedInboundCalls(
        { ...missedListQuery(applied, effectiveView), cursor: nextCursor, limit: PAGE_SIZE },
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

  /**
   * One row action: refused while the same kind of action is running on any row (each kind keeps
   * its own busy id), the refusal shown on the row, and on success the row replaced, or removed
   * from a view it no longer matches, with the announcement and every badge following.
   */
  const runRowAction = async (
    call: AgencyInboundMissedCall,
    [busy, setBusy]: [string | null, (id: string | null) => void],
    run: () => Promise<InboundResult<AgencyInboundMissedCall>>,
    on: {
      refusalCopy: (refusal: InboundRefusal) => string;
      stillMatches: (updated: AgencyInboundMissedCall) => boolean;
      announce: (updated: AgencyInboundMissedCall) => string;
      done?: () => void;
    },
  ) => {
    if (busy) return;
    setBusy(call.id);
    setRowError(null);
    const result = await run();
    setBusy(null);
    if (!result.ok) {
      setRowError({ id: call.id, message: on.refusalCopy(result.refusal) });
      return;
    }
    on.done?.();
    const updated = result.value;
    const keep = on.stillMatches(updated);
    setRows((current) => (keep ? current.map((r) => (r.id === call.id ? updated : r)) : current.filter((r) => r.id !== call.id)));
    setAnnouncement(on.announce(updated));
    refreshMissedCallsCount();
  };

  const markHandled = (call: AgencyInboundMissedCall) =>
    runRowAction(call, [marking, setMarking], () => markMissedInboundCallHandled(call.id, tenantId ?? undefined, accountId ?? undefined), {
      refusalCopy: (refusal) => inboundRefusalCopy(refusal),
      // Off the Open list, onto the Handled one: the row leaves the view it no longer matches.
      stillMatches: () => applied.status !== 'open',
      announce: () => `Marked the call from ${callerLabel(call)} as handled.`,
    });

  const reopen = (call: AgencyInboundMissedCall) =>
    runRowAction(call, [reopening, setReopening], () => reopenMissedInboundCall(call.id, tenantId ?? undefined, accountId ?? undefined), {
      refusalCopy: reopenRefusalCopy,
      // Off the Handled list, back onto the Open one.
      stillMatches: () => applied.status !== 'handled',
      announce: () => `Reopened the call from ${callerLabel(call)}. It is back on the list to follow up.`,
    });

  const reassign = (call: AgencyInboundMissedCall, to: string) =>
    runRowAction(
      call,
      [assigning, setAssigning],
      () => assignMissedInboundCall(call.id, to === '' ? null : to, tenantId ?? undefined, accountId ?? undefined),
      {
        refusalCopy: reassignRefusalCopy,
        // A filter on the assignee no longer matches a row given to someone else: it leaves the view.
        stillMatches: (updated) => {
          const filter = applied.assignee;
          return !filter
            || (filter === 'unassigned' ? updated.assignee_user_id === null
              : filter === 'me' ? updated.assignee_user_id === userId
                : updated.assignee_user_id === filter);
        },
        announce: (updated) => {
          const assignee = missedAssigneeLabel(updated, userId);
          return `Assigned the call from ${callerLabel(call)} to ${assignee === 'You' || assignee === 'The account' ? assignee.toLowerCase() : assignee}.`;
        },
        done: () => setReassigning(null),
      },
    );

  const claim = (call: AgencyInboundMissedCall) =>
    runRowAction(call, [claiming, setClaiming], () => claimMissedInboundCall(call.id, tenantId ?? undefined, accountId ?? undefined), {
      refusalCopy: claimRefusalCopy,
      // Theirs now: off the Team view, onto their own list (read again when they open it).
      stillMatches: () => false,
      announce: () => claimedNotice(callerLabel(call)),
      done: () => setClaimNote(claimedNotice(callerLabel(call))),
    });

  const switchView = (next: MissedView) => {
    if (next === view) return;
    setRowError(null);
    setClaimNote(null);
    setView(next);
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
  const open = team || applied.status === 'open';

  return (
    <div className={styles.page} data-testid="missed-calls-list">
      {supervise ? null : (
        <div className={styles.tabs} role="tablist" aria-label="Whose missed calls">
          {(['mine', 'team'] as const).map((which) => (
            <button
              key={which}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={view === which}
              aria-controls="missed-calls-panel"
              onClick={() => switchView(which)}
              data-testid={`missed-view-${which}`}
            >
              {which === 'mine' ? MISSED_TEAM_COPY.mineTab : MISSED_TEAM_COPY.teamTab}
            </button>
          ))}
        </div>
      )}
      {team ? (
        <p className={styles.note} data-testid="missed-team-lead">{MISSED_TEAM_COPY.lead}</p>
      ) : (
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
      )}
      {team && claimNote ? (
        <p className={missedStyles.notice} data-testid="missed-claimed-note">
          {claimNote}{' '}
          <button type="button" className={missedStyles.inlineLink} onClick={() => switchView('mine')} data-testid="missed-claimed-show">
            Show your missed calls
          </button>
        </p>
      ) : null}

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
      {error ? <ErrorAlert message={error} onRetry={() => void load(applied, effectiveView)} /> : null}

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
          title={active > 0 ? 'Nothing matches those filters' : team ? MISSED_TEAM_COPY.emptyTitle : open ? 'No missed calls to follow up' : 'No handled missed calls'}
          description={
            active > 0
              ? 'Widen the dates or clear the filters.'
              : team
                ? MISSED_TEAM_COPY.emptyDescription
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
                {team ? MISSED_TEAM_COPY.caption : open ? 'Missed calls to follow up, newest first' : 'Handled missed calls, newest first'}
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
                      {missedCallerName(call) ? (
                        <span className={missedStyles.callerName} data-testid="missed-caller-name">{missedCallerName(call)}</span>
                      ) : null}
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
                      <span className={styles.reason} data-testid="missed-reason">{missedReasonLabel(call)}</span>
                      {call.has_voicemail ? <span className={styles.sub}>Left a voicemail</span> : null}
                      {/* P2: playable once the server serves it (`voicemail_url`). */}
                      {call.has_voicemail && call.voicemail_url ? (
                        <VoicemailPlayer voicemailUrl={call.voicemail_url} callerLabel={callerLabel(call)} />
                      ) : null}
                    </td>
                    <td data-label="Campaign">
                      {call.matched_campaign_name ?? <span className={styles.muted}>Not matched</span>}
                      {call.callback_due_at ? (
                        <span className={styles.sub}>Callback booked for {formatSpineTimestamp(call.callback_due_at)}</span>
                      ) : null}
                    </td>
                    {supervise ? (
                      <td data-label="Assigned to">
                        <span data-testid="missed-assignee">{missedAssigneeLabel(call, userId)}</span>
                        {departedAssigneeNote(call) ? (
                          <span className={styles.sub} data-testid="missed-departed">{departedAssigneeNote(call)}</span>
                        ) : null}
                        {call.status === 'open' ? (
                          reassigning?.id === call.id ? (
                            <div className={missedStyles.reassign}>
                              <label className={styles.srOnly} htmlFor={`reassign-${call.id}`}>
                                Assign the call from {callerLabel(call)} to
                              </label>
                              <select
                                id={`reassign-${call.id}`}
                                className={styles.select}
                                value={reassigning.to}
                                onChange={(e) => setReassigning({ id: call.id, to: e.target.value })}
                                disabled={assigning !== null}
                                data-testid="missed-reassign-select"
                              >
                                <option value="">The account</option>
                                {members.filter((m) => m.assignable).map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.id === userId ? `${m.name} (you)` : m.name}
                                  </option>
                                ))}
                              </select>
                              <div className={styles.rowActions}>
                                <button
                                  type="button"
                                  className="btn-primary"
                                  onClick={() => void reassign(call, reassigning.to)}
                                  disabled={assigning !== null || reassigning.to === (call.assignee_user_id ?? '')}
                                  data-testid="missed-reassign-save"
                                >
                                  {assigning === call.id ? 'Assigning…' : 'Assign'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={() => setReassigning(null)}
                                  disabled={assigning !== null}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className={call.assignee_departed ? `btn-primary ${missedStyles.promptButton}` : missedStyles.linkButton}
                              onClick={() => {
                                setRowError(null);
                                setReassigning({ id: call.id, to: call.assignee_departed ? '' : (call.assignee_user_id ?? '') });
                              }}
                              aria-label={`Reassign the call from ${callerLabel(call)}`}
                              data-testid="missed-reassign"
                            >
                              <UserRoundPen size={13} aria-hidden="true" />
                              Reassign
                            </button>
                          )
                        ) : null}
                      </td>
                    ) : null}
                    <td data-label={open ? 'Follow up' : 'Handled'}>
                      {call.status === 'handled' ? (
                        <div>
                          <span data-testid="missed-handled">
                            {missedHandledLabel(call, userId)}
                            <span className={styles.sub}>{formatSpineTimestamp(call.handled_at)}</span>
                            {call.handled_reason === 'reached' ? <span className={styles.sub}>{MISSED_REACHED_NOTE}</span> : null}
                          </span>
                          <button
                            type="button"
                            className={missedStyles.linkButton}
                            onClick={() => void reopen(call)}
                            disabled={reopening !== null}
                            aria-label={`Reopen the call from ${callerLabel(call)}`}
                            data-testid="missed-reopen"
                          >
                            <RotateCcw size={13} aria-hidden="true" />
                            {reopening === call.id ? 'Reopening…' : 'Reopen'}
                          </button>
                          {rowError?.id === call.id ? (
                            <p className="error-text" role="alert">
                              {rowError.message}
                            </p>
                          ) : null}
                        </div>
                      ) : team ? (
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => void claim(call)}
                            disabled={claiming !== null}
                            aria-label={`Claim the call from ${callerLabel(call)}`}
                            data-testid="missed-claim"
                          >
                            <UserPlus size={13} aria-hidden="true" />
                            {claiming === call.id ? 'Claiming…' : 'Claim'}
                          </button>
                          {rowError?.id === call.id ? (
                            <p className="error-text" role="alert">
                              {rowError.message}
                            </p>
                          ) : null}
                        </div>
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
          {open && !team && !canCallBack ? (
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
  return missedCallerLabel(call, formatDialNumber);
}
