import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PhoneOutgoing, RotateCcw, Search, X } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useModalFocus } from '../../hooks/useModalFocus';
import { getMyContactsSummary, listMyContacts } from '../../api/agencyAssignment';
import { callMyContact, retryMyContacts } from '../../api/agencyMyContacts';
import { errorCode } from '../../utils/agencyErrors';
import { formatSpineTimestamp } from '../../utils/agencySpineCopy';
import { CONTACT_BUCKET_LABELS } from '../../utils/agencyAssignmentCopy';
import {
  MY_CONTACT_FILTER_BUCKETS,
  agentRetryRefusal,
  contactCallGate,
  type CallGate,
  overrideBadge,
  showRetryNotReached,
} from '../../utils/agencyMyContactsCopy';
import { overrideNoteBlock, overrideNoteLength } from '../../utils/softphone/overrides';
import {
  trackAgencyAgentRetry,
  trackAgencyMyContactCall,
  trackAgencyMyContactsOpened,
} from '../../analytics/events';
import { AGENCY_OVERRIDE_NOTE_MAX, AGENCY_OVERRIDE_NOTE_MIN } from '@magick-agency/contracts/agency';
import type { AgencyAgentState, AgencyQueueState } from '../../types/agency';
import type {
  AgencyAgentRetryErrorCode,
  AgencyAssignmentMode,
  AgencyMyContact,
  AgencyMyContactBucket,
  AgencyMyContactsSummary,
} from '@magick-agency/contracts/api/agency/assignment';
import styles from './MyContactsPanel.module.css';

/**
 * My contacts: the agent's own contacts on this campaign, from the station.
 *
 * ── Why a panel over the station, and not a column or a page ────────────────
 * The station's rules (`AgentConsolePage`) freeze its geometry and its tab
 * order, and the idle guide is deliberately text only: an interactive list in
 * the middle column while idle would put controls into the tab sequence
 * between "waiting" and "connected", the moment a misclick hangs up on a person.
 * A sibling page (`/dialer/contacts`) keeps the station rules but closes the
 * station socket — and "Call" places a call on THIS station's session, which
 * would then ring with no console attached.
 *
 * So it is a modal panel opened from the header: the console underneath does
 * not move and keeps its socket, the panel traps its own focus, and the header
 * button is refused in place (with the reason) while a call is reserved, live or
 * in wrap-up. A `reserved` frame closes it — the parent unmounts it the moment
 * the agent state leaves the idle states — so a call never lands behind it.
 *
 * Every refusal is an `AgencyAgentRetryErrorCode`, worded by
 * `agentRetryRefusal`.
 */

const PAGE_SIZE = 25;

export interface MyContactsPanelProps {
  campaignId: string;
  campaignName?: string | null;
  assignmentMode: AgencyAssignmentMode | null;
  /** The station session "Call" dials from; null while it is not connected. */
  sessionId: string | null;
  agentState: AgencyAgentState;
  dialing: boolean;
  /** The agent's queue as the station states it (`outside_calling_hours` asks for a note up front). */
  queue: AgencyQueueState | null;
  onClose: () => void;
  /** A call was placed: the station takes it from here. */
  onCalled: (contact: AgencyMyContact) => void;
  /** Injectable clock for the due-now test. */
  now?: () => number;
}

/** Why the note prompt opened: the window is closed and this contact may be called outside it. */
export const NOTE_NEEDED_REASON =
  'The campaign is outside its calling hours. You may still call this contact — say why in a note.';

/** A disabled Call's reason while the note prompt is open for another contact. */
export const NOTE_PROMPT_OPEN_REASON = 'Finish or cancel the note above first.';

/** A pending "Call" waiting for the agent's calling-hours note. */
interface NotePrompt {
  contact: AgencyMyContact;
  /** Why the note is asked for (the server's refusal, or the closed window up front). */
  reason: string;
}

export function MyContactsPanel({
  campaignId,
  campaignName,
  assignmentMode,
  sessionId,
  agentState,
  dialing,
  queue,
  onClose,
  onCalled,
  now = Date.now,
}: MyContactsPanelProps) {
  const { tenantId, accountId } = useTenant();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, panelRef);

  const [summary, setSummary] = useState<AgencyMyContactsSummary | null>(null);
  const [rows, setRows] = useState<AgencyMyContact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** An action's outcome, in words, in the panel's one polite live region. */
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [bucket, setBucket] = useState<AgencyMyContactBucket | ''>('');
  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');
  const [applied, setApplied] = useState<{ bucket: AgencyMyContactBucket | ''; phone: string; q: string }>(
    { bucket: '', phone: '', q: '' },
  );

  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notePrompt, setNotePrompt] = useState<NotePrompt | null>(null);
  const [note, setNote] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    trackAgencyMyContactsOpened({ campaign_id: campaignId, assignment_mode: assignmentMode });
  }, [campaignId, assignmentMode]);

  const load = useCallback(async () => {
    if (!tenantId || !accountId) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, page] = await Promise.all([
        getMyContactsSummary(campaignId, tenantId, accountId),
        listMyContacts({
          campaign_id: campaignId,
          ...(applied.bucket ? { bucket: [applied.bucket] } : {}),
          ...(applied.phone ? { phone: applied.phone } : {}),
          ...(applied.q ? { q: applied.q } : {}),
          limit: PAGE_SIZE,
        }, tenantId, accountId),
      ]);
      if (mine !== seq.current) return;
      setSummary(nextSummary);
      setRows(page.rows);
      setCursor(page.next_cursor);
      setPicked(new Set());
    } catch (err: unknown) {
      if (mine !== seq.current) return;
      setError(agentRetryRefusal(err, 'Could not load your contacts.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [campaignId, tenantId, accountId, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const onLoadMore = useCallback(async () => {
    if (!cursor || !tenantId || !accountId) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const page = await listMyContacts({
        campaign_id: campaignId,
        ...(applied.bucket ? { bucket: [applied.bucket] } : {}),
        ...(applied.phone ? { phone: applied.phone } : {}),
        ...(applied.q ? { q: applied.q } : {}),
        cursor,
        limit: PAGE_SIZE,
      }, tenantId, accountId);
      if (mine !== seq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setCursor(page.next_cursor);
    } catch (err: unknown) {
      setNotice({ tone: 'error', text: agentRetryRefusal(err, 'Could not load more contacts.') });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, campaignId, tenantId, accountId, applied]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy === null) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ bucket, phone: phone.trim(), q: text.trim() });
  };

  const pickBucket = (next: AgencyMyContactBucket) => {
    const value = applied.bucket === next ? '' : next;
    setBucket(value);
    setApplied((current) => ({ ...current, bucket: value }));
  };

  // ── Retry not reached ───────────────────────────────────────────────────────
  const retryScope: 'all' | 'selected' = picked.size > 0 ? 'selected' : 'all';
  const retryCount = picked.size > 0 ? picked.size : (summary?.retry.eligible ?? 0);

  const onRetry = useCallback(async () => {
    if (!tenantId || !accountId) return;
    setBusy('retry');
    setNotice(null);
    const ids = [...picked];
    try {
      const result = await retryMyContacts(
        { campaign_id: campaignId, ...(ids.length > 0 ? { contact_ids: ids } : { all: true }) },
        tenantId,
        accountId,
      );
      trackAgencyAgentRetry({
        campaign_id: campaignId,
        scope: retryScope,
        requested: retryCount,
        outcome: 'reopened',
        reopened: result.reopened,
        skipped_total: result.skipped_total,
        code: null,
      });
      const s = (n: number) => (n === 1 ? '' : 's');
      setNotice({
        tone: 'ok',
        text: `${result.reopened.toLocaleString()} contact${s(result.reopened)} back in your queue — they’ll be dialled as they come up.`
          + (result.skipped_total > 0
            ? ` ${result.skipped_total.toLocaleString()} couldn’t be retried.`
            : ''),
      });
      setConfirmRetry(false);
      await load();
    } catch (err: unknown) {
      trackAgencyAgentRetry({
        campaign_id: campaignId,
        scope: retryScope,
        requested: retryCount,
        outcome: 'refused',
        reopened: 0,
        skipped_total: 0,
        code: errorCode(err) as AgencyAgentRetryErrorCode | null,
      });
      setNotice({ tone: 'error', text: agentRetryRefusal(err, 'Nothing was retried.') });
      setConfirmRetry(false);
    } finally {
      setBusy(null);
    }
  }, [tenantId, accountId, picked, campaignId, retryScope, retryCount, load]);

  // ── Call one contact ──────────────────────────────────────────────────────
  const placeCall = useCallback(async (contact: AgencyMyContact, overrideNote?: string) => {
    if (!tenantId || !accountId || !sessionId) return;
    setBusy(contact.id);
    setNotice(null);
    try {
      const result = await callMyContact(
        contact.id,
        {
          campaign_id: campaignId,
          session_id: sessionId,
          ...(overrideNote !== undefined ? { override_note: overrideNote.trim() } : {}),
        },
        tenantId,
        accountId,
      );
      trackAgencyMyContactCall({
        campaign_id: campaignId,
        bucket: contact.bucket,
        with_override_note: overrideNote !== undefined,
        outcome: 'placed',
        code: null,
        override_applied_count: result.override_applied.length,
        retry_round_spent: result.retry_round_spent,
      });
      setNotePrompt(null);
      setNote('');
      onCalled(contact);
    } catch (err: unknown) {
      const code = errorCode(err) as AgencyAgentRetryErrorCode | null;
      trackAgencyMyContactCall({
        campaign_id: campaignId,
        bucket: contact.bucket,
        with_override_note: overrideNote !== undefined,
        outcome: 'refused',
        code,
        override_applied_count: 0,
        retry_round_spent: false,
      });
      const message = agentRetryRefusal(err, 'The call wasn’t placed.');
      if (code === 'override_note_invalid' && overrideNote === undefined) {
        // The contact's window is closed and it holds an unspent calling-hours
        // override: the server asks for the agent's reason (`override_note_invalid`
        // with no note sent; without the override it would be
        // `outside_calling_hours`). Ask for the note instead of only refusing.
        setNotePrompt({ contact, reason: NOTE_NEEDED_REASON });
      } else if (notePrompt?.contact.id === contact.id) {
        // A refusal of the prompt's own call (a note that was sent included) stays
        // inside the prompt, beside the note. Never re-targeted to another contact.
        setNotePrompt({ contact, reason: message });
      } else {
        setNotice({ tone: 'error', text: message });
      }
    } finally {
      setBusy(null);
    }
  }, [tenantId, accountId, sessionId, campaignId, onCalled, notePrompt]);

  const onCall = (contact: AgencyMyContact) => {
    // Known to be outside the window already: the note is needed, so ask first.
    if (contact.override?.calling_hours && queue?.reason === 'outside_calling_hours') {
      setNotePrompt({ contact, reason: NOTE_NEEDED_REASON });
      return;
    }
    void placeCall(contact);
  };

  const station = useMemo(() => ({ sessionId, agentState, dialing }), [sessionId, agentState, dialing]);
  // The row checkboxes pick what "Retry" sends, so they exist only while it is offered.
  const retryOffered = summary !== null && showRetryNotReached(summary);
  const nowMs = now();
  const noteLength = overrideNoteLength(note);

  const countButton = (key: AgencyMyContactBucket, label: string, extra?: string | null) => (
    <button
      type="button"
      className={styles.count}
      aria-pressed={applied.bucket === key}
      onClick={() => pickBucket(key)}
      data-testid={`my-count-${key}`}
    >
      <span className={styles.countValue}>{(summary?.counts[key] ?? 0).toLocaleString()}</span>
      <span className={styles.countLabel}>{label}</span>
      {extra ? <span className={styles.countExtra}>{extra}</span> : null}
    </button>
  );

  return (
    <div className={styles.overlay} role="presentation" onClick={() => { if (busy === null) onClose(); }}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="my-contacts-title"
        onClick={(event) => event.stopPropagation()}
        data-testid="my-contacts"
      >
        <div className={styles.header}>
          <div>
            <h2 className={styles.title} id="my-contacts-title">My contacts</h2>
            <p className={styles.subtitle}>
              {campaignName ? `The contacts assigned to you on ${campaignName}.` : 'The contacts assigned to you.'}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close My contacts">
            <X size={16} />
          </button>
        </div>

        <div className={styles.summary} data-testid="my-summary">
          {countButton('pending', CONTACT_BUCKET_LABELS.pending)}
          {countButton(
            'callback',
            CONTACT_BUCKET_LABELS.callback,
            queue?.reason === 'callbacks_later' && queue.next_due_at
              ? `next ${formatSpineTimestamp(queue.next_due_at)}`
              : null,
          )}
          {countButton('not_reached', CONTACT_BUCKET_LABELS.not_reached)}
          {countButton('reached', CONTACT_BUCKET_LABELS.reached)}
          {countButton('exhausted', CONTACT_BUCKET_LABELS.exhausted)}
          {countButton('suppressed', 'DNC')}
        </div>

        {retryOffered && summary ? (
          <div className={styles.retryRow}>
            {confirmRetry ? (
              <div className={styles.confirm} role="group" aria-label="Confirm retry" data-testid="my-retry-confirm">
                <p>
                  {`Put ${retryCount.toLocaleString()} contact${retryCount === 1 ? '' : 's'} you didn’t reach back in your queue? They’re dialled as they come up, and each uses one of its ${summary.retry.rounds} retr${summary.retry.rounds === 1 ? 'y' : 'ies'}.`}
                </p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void onRetry()}
                  disabled={busy !== null}
                  data-testid="my-retry-confirm-yes"
                >
                  {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmRetry(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmRetry(true)}
                disabled={busy !== null}
                data-testid="my-retry"
              >
                <RotateCcw size={14} aria-hidden="true" />
                {retryScope === 'selected'
                  ? `Retry selected (${retryCount.toLocaleString()})`
                  : `Retry not reached (${retryCount.toLocaleString()})`}
              </button>
            )}
          </div>
        ) : null}

        <form className={styles.filters} onSubmit={onSearch} role="search">
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Digits" inputMode="tel" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name or details</span>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Text in the contact’s details" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Show</span>
            <select value={bucket} onChange={(e) => setBucket(e.target.value as AgencyMyContactBucket | '')}>
              <option value="">Everyone</option>
              {MY_CONTACT_FILTER_BUCKETS.map((value) => (
                <option key={value} value={value}>{CONTACT_BUCKET_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary">
            <Search size={14} aria-hidden="true" /> Search
          </button>
        </form>

        <p className={notice?.tone === 'error' ? styles.noticeError : styles.notice} aria-live="polite" data-testid="my-notice">
          {notice?.text ?? ''}
        </p>

        {notePrompt ? (
          <div className={styles.notePrompt} role="group" aria-label="Note for calling outside hours" data-testid="my-note-prompt">
            <p className={styles.noteReason}>{notePrompt.reason}</p>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {`Why call ${notePrompt.contact.phone_e164} now? (${AGENCY_OVERRIDE_NOTE_MIN}–${AGENCY_OVERRIDE_NOTE_MAX} characters)`}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={AGENCY_OVERRIDE_NOTE_MAX * 2}
                data-testid="my-note"
              />
            </label>
            <p className={styles.noteCount}>{`${noteLength} / ${AGENCY_OVERRIDE_NOTE_MAX}`}</p>
            <div className={styles.noteActions}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void placeCall(notePrompt.contact, note)}
                disabled={overrideNoteBlock(note) !== null || busy !== null}
                data-testid="my-note-call"
              >
                Call with this note
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => { setNotePrompt(null); setNote(''); }}
                disabled={busy !== null}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.listWrap}>
          {error ? <p className={styles.noticeError} role="alert">{error}</p> : null}
          {loading ? <p className={styles.muted}>Loading your contacts…</p> : null}
          {!loading && !error && rows.length === 0 ? (
            <p className={styles.muted} data-testid="my-empty">
              {applied.bucket || applied.phone || applied.q
                ? 'Nothing matches. Clear the search to see all your contacts.'
                : 'Nobody is assigned to you on this campaign yet.'}
            </p>
          ) : null}
          {!loading && rows.length > 0 ? (
            <ul className={styles.list}>
              {rows.map((contact) => {
                // While the note prompt is open for one contact, no other row can
                // dial: its Call would otherwise race the prompt's own.
                const gate: CallGate = notePrompt && notePrompt.contact.id !== contact.id
                  ? { ok: false, reason: NOTE_PROMPT_OPEN_REASON }
                  : contactCallGate(contact, station, nowMs);
                const badge = overrideBadge(contact.override);
                const reasonId = `my-call-reason-${contact.id}`;
                return (
                  <li key={contact.id} className={styles.row} data-testid={`my-row-${contact.id}`}>
                    {retryOffered ? (
                      <input
                        type="checkbox"
                        className={styles.pick}
                        aria-label={`Include ${contact.phone_e164} in the retry`}
                        checked={picked.has(contact.id)}
                        disabled={!contact.retry.eligible}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setPicked((current) => {
                            const next = new Set(current);
                            if (checked) next.add(contact.id);
                            else next.delete(contact.id);
                            return next;
                          });
                        }}
                      />
                    ) : <span className={styles.pick} aria-hidden="true" />}
                    <div className={styles.who}>
                      <span className={styles.phone}>{contact.phone_e164}</span>
                      {contact.hero.length > 0 ? (
                        <span className={styles.hero}>
                          {contact.hero.map((field) => field.value).filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                      {badge ? <span className={styles.badge} data-testid={`my-override-${contact.id}`}>{badge}</span> : null}
                    </div>
                    <div className={styles.status}>
                      <span className={styles.bucket} data-bucket={contact.bucket}>{CONTACT_BUCKET_LABELS[contact.bucket]}</span>
                      <span className={styles.when}>
                        {contact.state === 'pending' ? `Next ${formatSpineTimestamp(contact.next_attempt_at)}` : ''}
                      </span>
                    </div>
                    <div className={styles.callCell}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => onCall(contact)}
                        disabled={!gate.ok || busy !== null}
                        aria-describedby={gate.ok ? undefined : reasonId}
                        data-testid={`my-call-${contact.id}`}
                      >
                        <PhoneOutgoing size={14} aria-hidden="true" />
                        {busy === contact.id ? 'Calling…' : 'Call'}
                      </button>
                      {!gate.ok ? (
                        <span id={reasonId} className={styles.callReason}>{gate.reason}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {cursor && !loading ? (
            <div className={styles.more}>
              <button type="button" className="btn-secondary" onClick={() => void onLoadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The header button's lock reason, or null when My contacts may open. */
export function myContactsLockReason(
  agentState: AgencyAgentState,
  connected: boolean,
): string | null {
  if (agentState === 'reserved' || agentState === 'on_call') return 'Finish this call first.';
  if (agentState === 'wrapup') return 'Save the outcome first.';
  if (!connected) return 'Your station isn’t connected.';
  return null;
}
