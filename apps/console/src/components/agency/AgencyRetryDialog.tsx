import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ShieldOff, X } from 'lucide-react';
import { createRetry, retryPreview } from '../../api/agencyCampaigns';
import { useTenant } from '../../contexts/TenantContext';
import { getErrorMessage } from '../../utils/errors';
import { useModalFocus } from '../../hooks/useModalFocus';
import { CallerIdPicker } from '../../pages/agency/CallerIdPicker';
import { HoldToConfirmButton, type HoldToConfirmCopy } from './HoldToConfirmButton';
import {
  defaultRetryName,
  describeSelector,
  dispositionBucketLabel,
  outcomeBucketLabel,
  droppedFilterNotice,
  refusedValueNotice,
  isSelectorEmpty,
  mintRetryIdempotencyKey,
  retryRefusalCopy,
  type NonSelectorContactFilter,
} from '../../utils/agencyRetrySelector';
import type { AgencyRetrySelector } from '../../types/agency-spine';
import type {
  AgencyCampaign,
  AgencyRetryCreateRequest,
  AgencyRetryCreateResponse,
  AgencyRetryPreview,
} from '../../types/agency-campaign';
import styles from './AgencyRetryDialog.module.css';

/**
 * Author a retry campaign from a cohort of a finished one.
 *
 * ── This dialog exists because the commit is not reversible ─────────────────
 * `POST .../retry` creates a campaign AND seeds its roster in one transaction,
 * and **there is no campaign delete route**. So the count has
 * to be seen before the button is pressed, and the count has to be
 * explained — which is the whole reason the preview carries a breakdown and an
 * `excluded` pair rather than just a number.
 *
 * ── Why the exclusion note is not a footnote ────────────────────────────────
 * `dnc` and `invalid` suppressions are removed from the seed unconditionally
 * — a customer's recorded request not to be contacted is not an operator
 * choice, and a bad number does not become good. A supervisor who ticks
 * "everything suppressed" and is shown 40 where they expected 300 will report it
 * as a bug unless the other 260 are accounted for on the same screen. So
 * `excluded` renders whenever it is non-zero, in the same block as the count,
 * and says which rule removed them.
 *
 * ── The one-running-campaign rule is stated UP FRONT ────────────────────────
 * `uq_agency_campaign_running (tenant_id, account_id) WHERE status='running'`
 * means a child cannot dial while its parent does. The child is created in
 * `draft` so creation never fails for that reason — but Start will, with
 * `409 another_campaign_running`, and that refusal is likely to be the
 * most common support ticket the feature generates. Telling the supervisor while
 * they are still authoring costs one sentence; telling them at Start costs a
 * refusal on a campaign they already made.
 *
 * ── What is NOT here ────────────────────────────────────────────────────────
 * The selector is not editable in this dialog. It arrives from the contacts tab
 * the supervisor already narrowed, or as the default "we did not reach them" set
 * when opened from the campaign header. A second filter editor
 * here would be a second place for the cohort to be decided, and the two would
 * disagree about what the screen behind the dialog is showing.
 */

/**
 * The gesture, in this surface's words.
 *
 * `self`-scoped keys: a page-wide `E`,`E` that creates a campaign is a worse
 * failure than any it prevents, and Tab-then-`E`,`E` keeps the control fully
 * keyboard-operable. `caller` confirmation: the create is an awaited request and
 * this component reports both outcomes itself, so there is no out-of-band
 * deadline to miss.
 */
/**
 * Exported so `HoldToConfirmButton.test.tsx` can drive the REAL retry config
 * rather than a hand-built approximation. `shortcutScope: 'self'` and
 * `confirmation: 'caller'` are the two decisions that make reusing the hang-up
 * control safe here, and a test against a copied literal would keep passing
 * after someone changed this one.
 */
export const RETRY_HOLD_COPY: HoldToConfirmCopy = {
  idPrefix: 'retry-create',
  labels: {
    idle: 'Create retry campaign',
    holding: 'Hold to create…',
    armed: 'Press E again to create',
    ending: 'Creating…',
    failed: 'Create retry campaign',
  },
  hint: 'Press and hold to create the campaign, or press E twice.',
  failedCopy: 'The campaign was not created. Nothing changed.',
  shortcutScope: 'self',
  confirmation: 'caller',
  analyticsControl: 'retry_campaign',
};

/** `HH:MM:SS` from Postgres, `HH:MM` for `<input type="time">`. */
function trimSeconds(value: string | null | undefined): string {
  if (!value) return '';
  return value.length >= 5 ? value.slice(0, 5) : value;
}

export interface AgencyRetryDialogProps {
  open: boolean;
  /** The PARENT. Its config is what the child inherits, and its catalog names the codes. */
  campaign: AgencyCampaign;
  selector: AgencyRetrySelector;
  /**
   * Contacts-tab filters that are not selector dimensions and were left behind.
   * Named on screen — see {@link droppedFilterNotice} for why loudly.
   */
  droppedFilters?: NonSelectorContactFilter[];
  /**
   * Contacts-tab filter VALUES that the API refuses outright and that were
   * therefore stripped from the selector — `dnc`, `invalid`, `in_flight`. Named
   * on screen for the same reason as `droppedFilters`, with a different
   * sentence: those are filters that do not translate, these are contacts that
   * can never be retried by anyone.
   */
  droppedValues?: string[];
  /**
   * Where this was opened from. The only thing it changes is one sentence: from
   * the contacts tab the cohort is the supervisor's own filtered list, and from
   * the campaign header it is a default they did not choose and should be told
   * about.
   */
  origin: 'filters' | 'campaign';
  onClose: () => void;
  onCreated: (result: AgencyRetryCreateResponse) => void;
}

export function AgencyRetryDialog({
  open,
  campaign,
  selector,
  droppedFilters = [],
  droppedValues = [],
  origin,
  onClose,
  onCreated,
}: AgencyRetryDialogProps) {
  const { tenantId, accountId } = useTenant();

  const [preview, setPreview] = useState<AgencyRetryPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [name, setName] = useState('');
  const [callerIds, setCallerIds] = useState<string[]>([]);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * Re-arms the hold button after a refusal.
   *
   * `HoldToConfirmButton` resets on a change of its subject and on nothing else,
   * which is what makes it one-shot. With `confirmation: 'caller'` there is no
   * timeout to fall back on, so a refused create would otherwise leave the
   * button reading "Creating…" over a campaign that does not exist.
   */
  const [attemptToken, setAttemptToken] = useState(0);
  /**
   * At-most-once, minted ONCE PER OPENING and deliberately NOT per request.
   *
   * That distinction is the entire mechanism. There is no campaign delete route
   * in the API, so a create whose RESPONSE is lost — a proxy timeout, a
   * pod eviction — leaves the supervisor looking at a failure over a campaign
   * that exists and is fully dialable. What they do next is press the button
   * again, and a key re-minted at that moment would collide with nothing and
   * build a second campaign over the same cohort: every customer in it dialled
   * twice, by two campaigns, with nothing in the product able to undo it.
   *
   * It is held stable across a REFUSAL for the same reason rather than in spite
   * of it: the API rolls a refusal back before writing the key, so pressing again
   * after "nothing matched" creates normally — but if that "refusal" was really
   * a lost success, the same key replays it instead of duplicating it.
   *
   * A ref, not state: nothing renders from it, and a `useState` write inside the
   * open effect would cost a second render on every opening of the dialog.
   */
  const idempotencyKey = useRef<string | undefined>(undefined);
  /** The dialog PANEL, not the overlay — see `useModalFocus`. */
  const dialogRef = useRef<HTMLDivElement>(null);

  const generation = campaign.retry_generation ?? 0;

  /*
    Seeded ONCE per opening, not on every render and not from a `useMemo`
    keyed on the campaign: the name, the caller IDs and the window are all
    editable, and re-deriving them would throw away the supervisor's edit the
    next time anything above re-rendered. The dependency is `open` alone for
    the same reason — reopening is a fresh authoring session, a re-render is
    not.
  */
  useEffect(() => {
    if (!open) return;
    setName(defaultRetryName(campaign.name, generation));
    setCallerIds([...(campaign.caller_ids ?? [])]);
    setWindowStart(trimSeconds(campaign.calling_window_start));
    setWindowEnd(trimSeconds(campaign.calling_window_end));
    setSubmitError(null);
    setAttemptToken((n) => n + 1);
    // A fresh intent. Reopening the dialog IS a new one — a supervisor who
    // closed it and came back means to author another campaign, so carrying the
    // previous key over would replay the last one and silently do nothing.
    idempotencyKey.current = mintRetryIdempotencyKey();
  }, [open]);

  const selectorKey = JSON.stringify(selector);

  useEffect(() => {
    if (!open || !tenantId || !accountId) return;
    if (isSelectorEmpty(selector)) {
      // The API answers 400 for a selector with no dimension at all. Refusing here
      // saves a round trip and, more importantly, says the same thing the API
      // would in words a supervisor can act on.
      setPreview(null);
      setPreviewError(
        'Pick at least one thing to select on. To retry the whole roster, select every contact state.',
      );
      return;
    }
    let live = true;
    setPreviewing(true);
    setPreviewError(null);
    retryPreview(campaign.id, selector, tenantId, accountId)
      .then((result) => {
        if (!live) return;
        setPreview(result);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPreview(null);
        setPreviewError(getErrorMessage(err, 'Could not work out how many contacts this matches.'));
      })
      .finally(() => {
        if (live) setPreviewing(false);
      });
    return () => {
      live = false;
    };
  }, [open, campaign.id, selectorKey, tenantId, accountId]);

  /** Escape closes, and the overlay click does too — the ordinary modal contract. */
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, onClose]);

  /**
   * Only what the supervisor CHANGED travels as an override.
   *
   * The child inherits the parent's whole config server-side, so
   * echoing an untouched value back would turn an inheritance into an explicit
   * write — indistinguishable on the row, and wrong the moment the parent's
   * value is what someone meant to carry forward.
   */
  const overrides = useMemo((): Partial<AgencyCampaign> => {
    const patch: Partial<AgencyCampaign> = {};
    const parentCallerIds = campaign.caller_ids ?? [];
    const changed =
      callerIds.length !== parentCallerIds.length
      || callerIds.some((id, i) => id !== parentCallerIds[i]);
    // `callerIds.length > 0` is NOT a "nothing changed" test — it is the reason
    // an empty selection has to block confirmation rather than be sent (see
    // `noCallerIds` below). Deselecting every ID and having the child silently
    // inherit the parent's would be the picker showing one thing and the
    // campaign dialling from another.
    if (changed && callerIds.length > 0) patch.caller_ids = callerIds;
    if (windowStart && windowStart !== trimSeconds(campaign.calling_window_start)) {
      patch.calling_window_start = windowStart;
    }
    if (windowEnd && windowEnd !== trimSeconds(campaign.calling_window_end)) {
      patch.calling_window_end = windowEnd;
    }
    return patch;
  }, [callerIds, windowStart, windowEnd, campaign]);

  /**
   * Every caller ID deselected.
   *
   * Blocked with a reason rather than sent. An empty `caller_ids` is not a
   * legal campaign — the picker requires one and so does the API — and the
   * override build above omits an empty array, so sending anyway would make the
   * child inherit the PARENT's IDs while the picker on screen shows none
   * selected. A supervisor who deliberately cleared the list would then get a
   * campaign dialling from the numbers they just removed, and nothing on the
   * screen would say so.
   *
   * Stated as a disabled reason rather than by preventing the last deselection,
   * because "I want to replace all of these" is an ordinary intent and the
   * natural way to do it is clear-then-pick.
   */
  const noCallerIds = callerIds.length === 0;

  const onConfirm = useCallback(() => {
    if (!tenantId || !accountId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: AgencyRetryCreateRequest = { selector };
    const trimmed = name.trim();
    if (trimmed) body.name = trimmed;
    if (Object.keys(overrides).length > 0) body.config_overrides = overrides;
    // Absent on a non-secure origin, which the API reads as an unkeyed create —
    // legal, and better than a dialog that cannot open at all.
    if (idempotencyKey.current) body.idempotency_key = idempotencyKey.current;

    createRetry(campaign.id, body, tenantId, accountId)
      .then((result) => {
        setSubmitting(false);
        onCreated(result);
      })
      .catch((err: unknown) => {
        setSubmitting(false);
        // Re-arm: without this the button sits at "Creating…" forever, over a
        // campaign that was never created.
        setAttemptToken((n) => n + 1);
        const code =
          typeof err === 'object' && err !== null
            ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
            : null;
        const stated =
          typeof code === 'string'
            ? retryRefusalCopy(code, {
                maxSeedRows: preview?.max_seed_rows,
                matched: preview?.matched,
              })
            : null;
        setSubmitError(stated ?? getErrorMessage(err, 'The campaign was not created.'));
      });
  }, [
    tenantId,
    accountId,
    submitting,
    selector,
    name,
    overrides,
    campaign.id,
    preview,
    onCreated,
  ]);

  // Focus in on open, Tab trapped inside, focus restored to the Retry trigger on
  // close. Without it, focus stayed on the trigger BEHIND the overlay and a
  // keyboard user tabbed through the page underneath instead of reaching the
  // self-scoped confirmation control — which made this element's own
  // `aria-modal="true"` untrue for exactly the users who rely on it.
  //
  // ⚠️ ABOVE the `!open` early return, like every other hook here. Below it the
  // component renders a different number of hooks when closed, and React tears
  // the tree down on the next open with "Rendered fewer hooks than expected".
  useModalFocus(open, dialogRef);

  if (!open) return null;

  const dropped = droppedFilterNotice(droppedFilters);
  const refused = refusedValueNotice(droppedValues);
  const excludedTotal = preview ? preview.excluded.dnc + preview.excluded.invalid : 0;
  const outcomeBuckets = Object.entries(preview?.by_last_outcome ?? {}).sort(
    ([, a], [, b]) => b - a,
  );
  const dispositionBuckets = Object.entries(preview?.by_last_disposition ?? {}).sort(
    ([, a], [, b]) => b - a,
  );
  const nothingMatched = preview !== null && preview.matched === 0;


  return (
    <div
      className={styles.overlay}
      onClick={() => {
        if (!submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agency-retry-title"
    >
      <div ref={dialogRef} className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <h2 className={styles.title} id="agency-retry-title">
              Retry these contacts
            </h2>
            <p className={styles.subtitle}>
              A new campaign, seeded from {campaign.name}. The original is left exactly as it is.
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {/*
            The cohort, in words, above the number it produces. A count with no
            statement of what it counted is a number a supervisor cannot check.
          */}
          <p className={styles.cohort} data-testid="retry-cohort">
            {describeSelector(selector, campaign.disposition_catalog)}
          </p>
          {origin === 'campaign' && (
            <p className={styles.originNote}>
              This is the default selection — the contacts we did not reach. Narrow it on the
              Contacts tab first if you want a different set.
            </p>
          )}
          {dropped && (
            <p className={styles.droppedNote} data-testid="retry-dropped-filters">
              {dropped}
            </p>
          )}
          {refused && (
            <p className={styles.droppedNote} data-testid="retry-refused-values">
              {refused}
            </p>
          )}

          <div className={styles.countBlock}>
            {previewing && !preview ? (
              <p className={styles.counting}>Counting…</p>
            ) : previewError ? (
              <p className={styles.countError} data-testid="retry-preview-error">
                {previewError}
              </p>
            ) : preview ? (
              <>
                <p className={styles.count} data-testid="retry-matched">
                  <strong>{preview.matched.toLocaleString()}</strong>
                  {' contact'}
                  {preview.matched === 1 ? '' : 's'}
                  {preview.parent_contacts_total > 0
                    ? ` of ${preview.parent_contacts_total.toLocaleString()}`
                    : ''}
                </p>

                {/*
                  Not decoration, and not a footnote. This is the difference
                  between "40" reading as a wrong number and reading as an
                  answer — see the block comment at the top of this file.
                */}
                {excludedTotal > 0 && (
                  <p className={styles.excluded} data-testid="retry-excluded">
                    <ShieldOff size={14} aria-hidden="true" />
                    <span>
                      {excludedTotal.toLocaleString()} more matched and {excludedTotal === 1 ? 'was' : 'were'}{' '}
                      left out
                      {preview.excluded.dnc > 0
                        ? ` — ${preview.excluded.dnc.toLocaleString()} on the Do Not Call list`
                        : ''}
                      {preview.excluded.dnc > 0 && preview.excluded.invalid > 0 ? ',' : ''}
                      {preview.excluded.invalid > 0
                        ? `${preview.excluded.dnc > 0 ? ' ' : ' — '}${preview.excluded.invalid.toLocaleString()} not a dialable number`
                        : ''}
                      . Neither is ever retried.
                    </span>
                  </p>
                )}

                {nothingMatched && (
                  <p className={styles.empty} data-testid="retry-empty">
                    Nothing to seed, so there is nothing to create. Widen the selection.
                  </p>
                )}

                {outcomeBuckets.length > 0 && (
                  <div className={styles.breakdown} data-testid="retry-by-outcome">
                    <h3 className={styles.breakdownTitle}>How the last call ended</h3>
                    <ul className={styles.breakdownList}>
                      {outcomeBuckets.map(([code, count]) => (
                        <li key={code} className={styles.breakdownRow}>
                          <span>{outcomeBucketLabel(code)}</span>
                          <span className={styles.breakdownCount}>{count.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {dispositionBuckets.length > 0 && (
                  <div className={styles.breakdown} data-testid="retry-by-disposition">
                    <h3 className={styles.breakdownTitle}>How the agent wrote it up</h3>
                    <ul className={styles.breakdownList}>
                      {dispositionBuckets.map(([code, count]) => (
                        <li key={code} className={styles.breakdownRow}>
                          <span>{dispositionBucketLabel(code, campaign.disposition_catalog)}</span>
                          <span className={styles.breakdownCount}>{count.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/*
            Said before the campaign is made, not after Start refuses it. One
            account runs one campaign at a time by unique index; the child is
            created in `draft` so this never blocks creation, only dialing.
          */}
          {campaign.status === 'running' && (
            <p className={styles.parentRunning} data-testid="retry-parent-running">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                {campaign.name} is still dialing. The retry will be created as a draft, and it
                cannot be started until this one is paused or stopped — one campaign runs at a time
                per account.
              </span>
            </p>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="retry-name">
              Campaign name
            </label>
            <input
              id="retry-name"
              className={styles.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              maxLength={255}
            />
          </div>

          {/*
            The two overrides that matter, and deliberately only these. A retry
            of a finished campaign is usually authored days later, when the
            caller-ID pool or the window has moved on — everything else the
            child inherits is right by construction, and a full config editor
            here would duplicate the Settings tab the supervisor can reach on
            the child the moment it exists.
          */}
          <details className={styles.overrides}>
            <summary className={styles.overridesSummary}>
              Caller IDs and calling hours
              <span className={styles.overridesHint}>
                Inherited from {campaign.name} unless you change them
              </span>
            </summary>
            <div className={styles.overridesBody}>
              <CallerIdPicker selected={callerIds} onChange={setCallerIds} disabled={submitting} />
              <div className={styles.windowRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="retry-window-start">
                    Calling starts
                  </label>
                  <input
                    id="retry-window-start"
                    className={styles.input}
                    type="time"
                    value={windowStart}
                    onChange={(event) => setWindowStart(event.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="retry-window-end">
                    Calling ends
                  </label>
                  <input
                    id="retry-window-end"
                    className={styles.input}
                    type="time"
                    value={windowEnd}
                    onChange={(event) => setWindowEnd(event.target.value)}
                    disabled={submitting}
                  />
                </div>
              </div>
            </div>
          </details>

          {submitError && (
            <p className={styles.submitError} role="alert" data-testid="retry-submit-error">
              {submitError}
            </p>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <HoldToConfirmButton
            attemptId={`retry-${campaign.id}-${attemptToken}`}
            enabled={preview !== null && preview.matched > 0 && !noCallerIds && !submitting}
            disabledReason={
              previewError
                ? 'Fix the selection first.'
                : noCallerIds
                  ? 'Choose at least one caller ID.'
                  : nothingMatched
                    ? 'Nothing matches this selection.'
                    : previewing
                      ? 'Counting the contacts…'
                      : null
            }
            onConfirm={onConfirm}
            copy={RETRY_HOLD_COPY}
          />
        </div>
      </div>
    </div>
  );
}
