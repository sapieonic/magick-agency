import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Calendar, PhoneOutgoing, RefreshCw } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../contexts/TenantContext';
import { getMyCalls } from '../../api/myCalls';
import { getMyCampaigns } from '../../api/agencyStats';
import { attemptDateRange } from '../../utils/agencyAttemptFilters';
import { INVERTED_RANGE_COPY } from '../../utils/agencyCampaignAttemptParams';
import { CallTypeChips } from './CallTypeChips';
import { FiltersCard } from './FiltersCard';
import { MissedFollowUpCell } from './MissedFollowUpCell';
import { getMissedInboundCall } from '../../api/inbound';
import { useMarkMissedHandled } from '../../hooks/useMarkMissedHandled';
import { hasPermission } from '../../utils/permissions';
import { softphonePrefillState } from '../../utils/softphone/prefill';
import { formatCallTimestamp, formatTalkTime } from '../../utils/agencySpineCopy';
import { dayOfInstant } from '../../utils/format/date';
import {
  AGENCY_CALLS_NO_CAMPAIGN,
  AGENCY_CALLS_NO_CAMPAIGN_LABEL,
  type AgencyCallLogTypeFilter,
  type AgencyMyCallbackDue,
  type AgencyMyCallRow,
  type AgencyMyCallsCounts,
} from '../../types/agency-call-log';
import {
  MY_CALLS_DATES_OFF_HINT,
  callbackDueCopy,
  myCallBackOf,
  myCallCustomer,
  myCallFollowUp,
  myCallOutcome,
  myCallOutcomePlaceholder,
  myCallTypeLine,
  myCallWhatHappened,
  myCallsChips,
  myCallsEmpty,
  myCallsFiltered,
  myCallsFiltersFromParams,
  myCallsParamsForFilters,
  myCallsParamsForType,
  myCallsTypeFromParams,
  type MyCallsFilters,
} from '../../utils/agency/myCalls';
import { isNotDialled } from '../../utils/agency/callLog';
import spine from './SpineListLayout.module.css';
import styles from '../../pages/agency/AgencyCampaignAttemptsPage.module.css';
import own from './MyCallsList.module.css';

const PAGE_SIZE = 50;
/** The missed-call Outcome cell's test ids on this list (each is completed with the row's id). */
const MY_CALLS_FOLLOW_UP_TEST_IDS = { cell: 'my-call-follow-up', callBack: 'my-call-back', markHandled: 'my-call-handled' };

/**
 * The signed-in person's own calls as one list (`docs/call-log.md` §7, CL9): their dials, the
 * soft-phone calls they placed, the inbound calls they answered and the missed calls that are
 * theirs to ring back, newest first, with chips over it. **To follow up** is first: their open
 * missed calls, then the callbacks they booked that are due today or late.
 *
 * No recording, no summary and no link to a call's page: an agent does not hear recordings,
 * their own included. A number its campaign hides from agents arrives masked from the server
 * (`phone_masked`) and is shown as it arrived.
 *
 * The chip is in the URL (`?type=`); `?view=softphone`, the old Soft-phone calls tab, opens the
 * Soft phone chip. So are the two filters, the campaign and the dates. There is no search by
 * number: on a campaign that hides numbers it would let the hidden digits be guessed (CL36).
 */
export function MyCallsList({ softphone, inbound, missedOpen = null }: {
  /** The reader may dial from the soft phone (the flag and `agency.softphone.dial`). */
  softphone: boolean;
  /** Missed calls are on for the reader (`useMissedCallsAccess().available`). */
  inbound: boolean;
  /**
   * The reader's OWN open Missed calls as the page's Missed calls badge counts them, live
   * (`useMissedCallsAccess().count.open`); null while unknown, and for a supervisor, whose badge
   * counts the account's rows. To follow up's badge counts the same rows: when this number is
   * not the one the list last read, what is owed is read again, so the two badges agree.
   */
  missedOpen?: number | null;
}) {
  const { tenantId, accountId, role } = useTenant();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type = useMemo(() => myCallsTypeFromParams(params), [params]);
  const filters = useMemo(() => myCallsFiltersFromParams(params), [params]);
  /** The campaigns the reader has worked, for the Campaign filter. A courtesy: rows name theirs. */
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [draftCampaign, setDraftCampaign] = useState(() => filters.campaign ?? '');
  const [draftFrom, setDraftFrom] = useState(() => dayOfInstant(filters.from));
  const [draftTo, setDraftTo] = useState(() => dayOfInstant(filters.to));
  useEffect(() => {
    setDraftCampaign(filters.campaign ?? '');
    setDraftFrom(dayOfInstant(filters.from));
    setDraftTo(dayOfInstant(filters.to));
  }, [filters]);

  const [rows, setRows] = useState<AgencyMyCallRow[]>([]);
  const [callbacks, setCallbacks] = useState<AgencyMyCallbackDue[]>([]);
  const [counts, setCounts] = useState<AgencyMyCallsCounts | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [calling, setCalling] = useState<string | null>(null);
  const seq = useRef(0);

  const canMarkHandled = hasPermission(role, 'agency.inbound.read');

  useEffect(() => {
    if (!tenantId || !accountId) return undefined;
    let live = true;
    getMyCampaigns(tenantId, accountId)
      .then((entries) => {
        if (!live) return;
        const named = new Map<string, string>();
        for (const entry of entries) if (entry.campaign_name) named.set(entry.campaign_id, entry.campaign_name);
        setCampaigns([...named].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
      })
      // The names are a courtesy on top of the calls: the list is shown without the picker's choices.
      .catch(() => { if (live) setCampaigns([]); });
    return () => {
      live = false;
    };
  }, [tenantId, accountId]);

  const load = useCallback(async (chip: AgencyCallLogTypeFilter, active: MyCallsFilters) => {
    if (!tenantId || !accountId) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    setMoreError(null);
    try {
      const page = await getMyCalls({ type: chip, ...sent(active), limit: PAGE_SIZE, includeCounts: true }, tenantId, accountId);
      if (mine !== seq.current) return;
      setRows(page.rows);
      setCallbacks(page.callbacks_due ?? []);
      setCounts(page.counts ?? null);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      if (mine !== seq.current) return;
      // The rows on screen belong to the previous chip: a failed load shows none.
      setRows([]);
      setCallbacks([]);
      setNextCursor(null);
      setError(getErrorMessage(err, 'Could not load your calls.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [tenantId, accountId]);

  useEffect(() => {
    void load(type, filters);
  }, [load, type, filters]);

  /**
   * The Missed calls badge moved (a call was just missed, or one was handled on the Missed
   * list): read what is owed again. Under To follow up the list itself changed, so it is read
   * again; under another chip only the counts are, and the rows and pages on screen stay.
   * Asked once for each number the badge shows, so a count the two reads never agree on (a row
   * changing between them) cannot loop.
   */
  const followedMissed = useRef<number | null>(null);
  useEffect(() => {
    if (missedOpen === null || loading || counts === null || !tenantId || !accountId) return;
    if (missedOpen === counts.missed_open) {
      followedMissed.current = null;
      return;
    }
    if (followedMissed.current === missedOpen) return;
    followedMissed.current = missedOpen;
    if (type === 'to_follow_up') {
      void load(type, filters);
      return;
    }
    const mine = seq.current;
    getMyCalls({ type, ...sent(filters), limit: 1, includeCounts: true }, tenantId, accountId)
      .then((page) => {
        if (mine === seq.current && page.counts) setCounts(page.counts);
      })
      // The badge keeps its last number; the next read of the list brings a new one.
      .catch(() => undefined);
  }, [missedOpen, counts, loading, type, filters, load, tenantId, accountId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await getMyCalls({ type, ...sent(filters), limit: PAGE_SIZE, cursor: nextCursor }, tenantId ?? undefined, accountId ?? undefined);
      if (mine !== seq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      if (mine === seq.current) setMoreError(getErrorMessage(err, 'Could not load older calls.'));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, type, filters, tenantId, accountId]);

  const choose = useCallback((next: AgencyCallLogTypeFilter) => {
    setParams(myCallsParamsForType(params, next), { replace: true });
  }, [params, setParams]);

  /** Mark handled: the Missed list's own action. The list and the badge are read again. */
  const reload = useCallback(() => {
    void load(type, filters);
  }, [load, type, filters]);
  const { marking, rowError, setRowError, markHandled } = useMarkMissedHandled(reload);

  /**
   * Call back: the soft phone with the caller's number on the pad, the call's campaign chosen
   * and the missed call's id, so the call placed is linked to it (CL1). Nothing is dialled until
   * the agent presses Call. Where the list shows the number hidden, it is not in the list at
   * all: this one Missed row is read by its id at this moment (the Missed list's own rule for
   * whose row it is), for the pad. By id, so it is found however many rows the agent has open.
   */
  const callBack = useCallback(async (row: AgencyMyCallRow) => {
    if (calling) return;
    setRowError(null);
    let number = row.phone_masked ? null : row.phone;
    if (!number) {
      setCalling(row.id);
      try {
        number = (await getMissedInboundCall(row.id, tenantId ?? undefined, accountId ?? undefined)).from_e164;
      } catch {
        number = null;
      } finally {
        setCalling(null);
      }
    }
    if (!number) {
      setRowError({ id: row.id, message: 'We could not open this call on the soft phone. Open Missed calls and call back from there.' });
      return;
    }
    navigate('/dialer/phone', {
      state: softphonePrefillState({ number, campaignId: row.campaign_id, inboundCallId: row.id }),
    });
  }, [calling, tenantId, accountId, navigate, setRowError]);

  const chips = useMemo(() => myCallsChips(counts, type, { softphone, inbound }), [counts, type, softphone, inbound]);
  /** To follow up is everyone still owed a call, whatever the dates (CL14): the date fields say so. */
  const datesOff = type === 'to_follow_up';
  const filtered = myCallsFiltered(filters);
  const empty = myCallsEmpty(type, datesOff ? filters.campaign !== null : filtered);
  const invertedRange = !datesOff && Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const apply = () => {
    setParams(myCallsParamsForFilters(params, {
      campaign: draftCampaign || null,
      ...{ from: null, to: null, ...attemptDateRange(draftFrom, draftTo) },
    }), { replace: true });
  };
  const clear = () => setParams(myCallsParamsForFilters(params, { campaign: null, from: null, to: null }), { replace: true });
  const nothing = rows.length === 0 && callbacks.length === 0;
  const now = new Date();

  return (
    <div>
      <div className={own.bar}>
        <CallTypeChips chips={chips} selected={type} onChoose={choose} label="Which calls" testIdPrefix="my-calls" badgesOnly />
        <button type="button" className={`${spine.actionButton} btn-secondary`} onClick={() => void load(type, filters)} disabled={loading} aria-label="Refresh my calls">
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <FiltersCard activeCount={(filters.campaign ? 1 : 0) + ((filters.from || filters.to) && !datesOff ? 1 : 0)}>
        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Campaign</span>
            <span className={spine.inputWrap}>
              <select
                className={spine.fieldInput}
                value={draftCampaign}
                onChange={(e) => setDraftCampaign(e.target.value)}
                data-testid="my-calls-campaign-filter"
              >
                <option value="">All campaigns</option>
                <option value={AGENCY_CALLS_NO_CAMPAIGN}>{AGENCY_CALLS_NO_CAMPAIGN_LABEL}</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {draftCampaign && draftCampaign !== AGENCY_CALLS_NO_CAMPAIGN && !campaigns.some((c) => c.id === draftCampaign) && (
                  <option value={draftCampaign}>One campaign</option>
                )}
              </select>
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>From date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input type="date" className={spine.fieldInput} value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} disabled={datesOff} />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>To date</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                disabled={datesOff}
                aria-describedby={datesOff ? 'my-calls-dates-off' : undefined}
              />
            </span>
            {datesOff && <span className={styles.fieldHint} id="my-calls-dates-off" data-testid="my-calls-dates-off">{MY_CALLS_DATES_OFF_HINT}</span>}
          </label>
        </div>
        <div className={spine.filterFooter}>
          {invertedRange && (
            <p className={spine.filterError} role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              {INVERTED_RANGE_COPY}
            </p>
          )}
          <div className={spine.filterActions}>
            <button type="button" className="btn-primary" onClick={apply} disabled={invertedRange} data-testid="my-calls-apply">Apply</button>
            {filtered && <button type="button" className="btn-secondary" onClick={clear} data-testid="my-calls-clear">Clear</button>}
          </div>
        </div>
      </FiltersCard>

      {error && <ErrorAlert message={error} onRetry={() => void load(type, filters)} />}
      {loading && <LoadingSpinner />}

      {!loading && !error && nothing && (
        <EmptyState icon={<PhoneOutgoing size={32} />} title={empty.title} description={empty.description} />
      )}

      {!loading && rows.length > 0 && (
        <div className={spine.tableWrap}>
          <table className={spine.table}>
            <caption className={styles.srOnly}>
              {type === 'to_follow_up' ? 'Missed calls you still owe a call back, newest first' : 'Your calls, newest first'}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Customer</th>
                <th scope="col">Campaign</th>
                <th scope="col">What happened</th>
                <th scope="col">Outcome</th>
                <th scope="col">Talk time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const customer = myCallCustomer(row);
                const happened = myCallWhatHappened(row);
                const followUp = myCallFollowUp(row);
                const outcome = myCallOutcome(row);
                const backOf = myCallBackOf(row);
                return (
                  <tr
                    key={`${row.type}:${row.id}`}
                    data-testid={`my-call-row-${row.id}`}
                    data-type={row.type}
                    className={isNotDialled(row) ? styles.notDialled : undefined}
                  >
                    <td className={styles.when}>{formatCallTimestamp(row.created_at)}</td>
                    <td>
                      <span className={styles.type} data-type={row.type} data-testid={`my-call-type-${row.id}`}>{myCallTypeLine(row)}</span>
                      {backOf && <span className={styles.secondLine}>{backOf}</span>}
                    </td>
                    <td data-testid={`my-call-customer-${row.id}`}>
                      {customer.name && <span>{customer.name}</span>}
                      <span className={customer.name ? styles.secondLine : row.phone === null ? styles.mutedCell : styles.numeric}>
                        {customer.number}
                      </span>
                    </td>
                    <td data-testid={`my-call-campaign-${row.id}`}>
                      {row.campaign_name ?? (
                        <span className={styles.mutedCell}>{row.campaign_id ? 'Campaign' : AGENCY_CALLS_NO_CAMPAIGN_LABEL}</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.outcome} data-outcome={happened.key} data-testid={`my-call-happened-${row.id}`}>{happened.text}</span>
                      {happened.detail && <span className={styles.secondLine}>{happened.detail}</span>}
                    </td>
                    <td>
                      {followUp ? (
                        <MissedFollowUpCell
                          rowId={row.id}
                          followUp={followUp}
                          onCallBack={softphone && row.phone !== null ? () => void callBack(row) : null}
                          callBackDisabled={calling !== null}
                          onMarkHandled={canMarkHandled ? () => void markHandled(row) : null}
                          marking={marking}
                          error={rowError?.id === row.id ? rowError.message : null}
                          testIds={MY_CALLS_FOLLOW_UP_TEST_IDS}
                        />
                      ) : (
                        <>
                          <span className={outcome ? undefined : styles.mutedCell} data-testid={`my-call-outcome-${row.id}`}>
                            {outcome ?? myCallOutcomePlaceholder(row)}
                          </span>
                          {/* The agent's own notes, as text. */}
                          {row.notes && <span className={styles.secondLine}>{row.notes}</span>}
                        </>
                      )}
                    </td>
                    <td className={styles.numeric}>{formatTalkTime(row.talk_seconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && type === 'to_follow_up' && callbacks.length > 0 && (
        <section className={own.callbacks} aria-labelledby="my-calls-callbacks-title" data-testid="my-calls-callbacks">
          <h2 id="my-calls-callbacks-title" className={own.callbacksTitle}>Callbacks due</h2>
          <ul className={own.callbackList}>
            {callbacks.map((callback) => {
              const copy = callbackDueCopy(callback, now);
              return (
                <li key={callback.contact_id} className={own.callback} data-testid={`my-callback-${callback.contact_id}`}>
                  <span className={own.callbackWho}>{callback.customer_name ?? 'A customer'}</span>
                  <span className={copy.late ? own.late : own.due}>{copy.due}</span>
                  <span className={styles.secondLine}>
                    {[callback.campaign_name, copy.booked].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {moreError && <p className={spine.filterError} role="alert">{moreError}</p>}
      {!loading && nextCursor && (
        <div className={spine.more}>
          <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore} data-testid="my-calls-load-more">
            {loadingMore ? 'Loading…' : 'Load older calls'}
          </button>
        </div>
      )}
    </div>
  );
}

export default MyCallsList;

/** The filters as the read takes them. */
function sent(filters: MyCallsFilters): { campaign?: string; from?: string; to?: string } {
  return {
    ...(filters.campaign ? { campaign: filters.campaign } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}
