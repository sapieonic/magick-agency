import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Calendar,
  ListChecks,
  PhoneOutgoing,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useAgentAttempts, type AgentAttemptsSubject } from '../../hooks/useAgentAttempts';
import { campaignLabel } from '../../utils/agencyAgentPerformance';
import {
  ATTEMPT_RANGE_NOTE,
  DISPOSITION_COMMA_NOTE,
  attemptDateRange,
  attemptFilterGroupCount,
  isAttemptFiltered,
  isInvertedDayRange,
  observedDispositionCodes,
} from '../../utils/agencyAttemptFilters';
import {
  formatSpineTimestamp,
  formatTalkTime,
  recordingCellCopy,
} from '../../utils/agencySpineCopy';
import {
  ATTEMPT_OUTCOME_LABELS,
  ATTEMPT_STATE_LABELS,
  attemptOutcomeLabel,
  attemptStateLabel,
  type AgencyAttempt,
} from '../../types/agency-spine';
import { EmptyState } from '../common/EmptyState';
import { ErrorAlert } from '../common/ErrorAlert';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { FilterChip } from './FilterChip';
import { FiltersCard } from './FiltersCard';
import spine from './SpineListLayout.module.css';
import styles from './AgentAttemptsPanel.module.css';

/**
 * One person's dial history, row per dial — and the only component that renders
 * it.
 *
 * ── Why one component serves two surfaces ──────────────────────────────────
 * "My calls" at `/dialer/attempts` (the agent's own) and the supervisor's
 * per-agent section on `AgencyAnalyticsPage` read the same rows from paired routes
 * with different floors. `AgentPerformancePanel` is shared between the same two
 * callers for the same reason, stated there: giving each its own renderer lets an
 * agent's view of their shift and their supervisor's view of the same shift drift
 * apart in wording, in rounding and in what counts as absent — and a coaching
 * conversation held over two different accounts of one afternoon is worse than
 * none. So the difference between the two surfaces is the shell around this panel
 * and which route filled it, nothing else.
 *
 * The `subject` discriminator is what makes that safe rather than merely tidy: it
 * decides which of the two paired routes is read (see `useAgentAttempts`) and it
 * decides the second person of the copy — "you haven't taken any calls" is a
 * sentence a supervisor must never be shown about somebody else.
 *
 * ── Cross-campaign is the entire point, so Campaign is a real column ──────
 * `/campaigns/:id/attempts` needs no campaign column: its URL is the answer. This
 * list is the opposite — an agent who works Renewals in the morning and
 * Collections after lunch has one history spanning both, and that is precisely
 * what no campaign-scoped view can show. `AgencyAttempt.campaign_id` exists for
 * this column.
 *
 * The row carries an **id and no name** (core has the name; the row does not), so
 * the name is resolved through a map the CALLER already holds — the agent's
 * staffing history on one surface, the account's campaign list on the other.
 * Never a fetch per row, and never a second list on this component's own account:
 * two campaign lists is two answers about which campaigns exist. An id with no
 * match degrades through `campaignLabel` to `Campaign <first 8 chars>`, which is
 * the honest reading — a campaign somebody was unstaffed from, or one core could
 * not identify, still has real attempts, and neither a blank cell (which says the
 * dial belonged to nothing) nor a bare UUID dressed as a name is true.
 *
 * ── There is deliberately NO CSV export here ───────────────────────────────
 * Considered and rejected on a hard fact, recorded so the next reader does not
 * take its absence for an oversight: the campaign spine has
 * `GET /campaigns/:id/attempts.csv`, and **master's performance plugin has no csv
 * route at all** — neither `my-attempts.csv` nor the supervisor twin. So
 * `downloadSpineCsv` pointed at this data would 404, and an Export button would be
 * a control that fails every time it is pressed. Adding the route is a
 * cross-service change (core, then master) rather than a screen change, and it is
 * not what this screen is for: an agent checking their own afternoon between calls
 * does not need a spreadsheet, and a supervisor who does need one already has the
 * campaign-scoped export where the row limits and truncation copy live.
 *
 * ── The phone search is back, and what had to land first ──────────────────
 * It was removed rather than left broken. Master's whitelist for the two agent
 * routes (`AGENT_ATTEMPT_QUERY_PARAMS`) did not carry `phone`, and
 * `forwardAllowedQuery` dropped an unlisted key **silently** — so the control
 * answered 200 with the person's whole unfiltered history and presented it as
 * the calls matching their search: more rows than were asked for, every one of
 * them wrong, and nothing on screen saying so. A control that 400s would at
 * least be visible.
 *
 * Both halves have since landed on master. `phone` is forwarded on both agent
 * routes, and `forwardAllowedQuery` now **rejects** an unknown key with a 400
 * instead of dropping it — which is the half that matters more, because it means
 * the next param this surface sends can no longer fail invisibly. So the search
 * is real and the input is back.
 *
 * ── The link to the call is conditional on `subject`, and that is the whole ─
 *
 * It used to be absent on both surfaces, for a reason that is only true of one of
 * them. The agency-native call detail lives under `AgencyLayout`, and
 * `AgencyHomeRedirect` bounces a non-supervisor persona to `/dialer` — so an
 * `agent` (hierarchy level 5) cannot reach it, and a row link that lands them
 * somewhere they are bounced out of is the same trap `/dialer` exists to avoid,
 * one shell along. That still holds for `subject.kind === 'me'` at
 * `/dialer/attempts`, and reaching it from there needs a `/dialer/...` twin
 * outside the agency shell; it does **not** need the `agent` role raised, which
 * stays at level 5 deliberately.
 *
 * But `subject.kind === 'agent'` is a SUPERVISOR reading somebody else's shift
 * from inside `AgencyAnalyticsPage` — the prop's own contract requires
 * `agency.supervise` — and their stated reason for being there is that a connect
 * rate which looks wrong is a claim about individual calls. Withholding the link
 * there left two lists of the same rows, one of which was a dead end, and sent
 * the supervisor to the campaign's own attempts view to find a row they were
 * already looking at. So the link renders for the supervisor and not for the
 * agent, keyed on the discriminator that already decides which route filled this
 * panel and which person the copy addresses.
 */

export interface AgentAttemptsPanelProps {
  /** Whose calls. `{ kind: 'agent' }` REQUIRES `hasPermission(role, 'agency.supervise')`. */
  subject: AgentAttemptsSubject;
  /**
   * Campaign id → name, for the campaign column and the campaign filter.
   *
   * A prop rather than a fetch, for the reason `AgentPerformancePanel` takes the
   * same one: the two surfaces have different lists to resolve from and neither
   * belongs to this component. An empty map is a supported state, not a bug — the
   * column degrades to a shortened id rather than to a blank.
   */
  campaignNames: ReadonlyMap<string, string | null>;
  /**
   * What to call the table for a screen reader, e.g. "Calls you have taken".
   * Supplied by the caller because only the caller knows whose calls these are.
   */
  caption: string;
}

export function AgentAttemptsPanel({ subject, campaignNames, caption }: AgentAttemptsPanelProps) {
  const mine = subject.kind === 'me';
  const { page, filters, applyFilters, reload, loadMore, loadingMore, moreError } =
    useAgentAttempts(subject);

  /**
   * Draft vs applied.
   *
   * Typing a write-up code must not fire a request per keystroke, and the count
   * and the rows must always describe the filters that were actually sent — not
   * the ones half-edited in the card above them. The applied set lives in the
   * hook, which is also what makes a filter change reset the cursor by
   * construction.
   */
  const [draftOutcomes, setDraftOutcomes] = useState<string[]>([]);
  const [draftStates, setDraftStates] = useState<string[]>([]);
  const [draftCodes, setDraftCodes] = useState<string[]>([]);
  const [draftCampaign, setDraftCampaign] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  /** The free-text box for a code that is not on any loaded row. */
  const [codeEntry, setCodeEntry] = useState('');
  /**
   * Analytics-only: whether the free-text box (as opposed to a chip click)
   * contributed to `draftCodes` since the last apply/clear. `draftCodes` itself
   * merges both origins into one array, so this is the only place left that
   * still knows which control the operator actually used.
   */
  const usedFreeTextRef = useRef(false);

  const rows = page.status === 'ready' ? page.rows : [];

  /**
   * Codes to offer as chips: the ones on the rows in hand, plus whatever is
   * selected. Never presented as the complete set — see `observedDispositionCodes`
   * and the note rendered beside them.
   */
  const codeOptions = useMemo(() => observedDispositionCodes(rows, draftCodes), [rows, draftCodes]);

  /**
   * Campaigns to offer, from the caller's map.
   *
   * Sorted by the label the reader sees rather than by id, and it deliberately
   * offers only what the caller could name: a campaign present in the ROWS but
   * absent from the map has no name to put in an option, and an option reading
   * `Campaign 4f21ab90` is a thing nobody can recognise well enough to choose.
   * The column still shows it — that is a different question, because there the
   * reader is being told what a row was, not asked to pick.
   */
  const campaignOptions = useMemo(
    () =>
      [...campaignNames.entries()]
        .filter(([, name]) => Boolean(name))
        .map(([id, name]) => ({ id, name: name as string }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [campaignNames],
  );

  const invertedRange = isInvertedDayRange(draftFrom, draftTo);

  const onApply = useCallback(() => {
    applyFilters({
      ...(draftOutcomes.length > 0 ? { outcome: draftOutcomes } : {}),
      ...(draftStates.length > 0 ? { state: draftStates } : {}),
      ...(draftCodes.length > 0 ? { disposition_code: draftCodes } : {}),
      ...(draftCampaign ? { campaign_id: draftCampaign } : {}),
      // Trimmed, the same as `AgencyCampaignAttemptsPage` trims it: a trailing
      // space off a copied number is not part of the number, and sending it is
      // a search that matches nothing for a reason the reader cannot see.
      ...(draftPhone.trim() ? { phone: draftPhone.trim() } : {}),
      // Inclusive `to`, on `created_at`. Both facts belong to the route and not to
      // this component — `attemptDateRange` owns them, and its docstring is where
      // the difference from the performance page's range is written down.
      ...attemptDateRange(draftFrom, draftTo),
    }, { usedFreeText: usedFreeTextRef.current });
    usedFreeTextRef.current = false;
  }, [
    applyFilters,
    draftOutcomes,
    draftStates,
    draftCodes,
    draftCampaign,
    draftPhone,
    draftFrom,
    draftTo,
  ]);

  const onClear = useCallback(() => {
    setDraftOutcomes([]);
    setDraftStates([]);
    setDraftCodes([]);
    setDraftCampaign('');
    setDraftPhone('');
    setDraftFrom('');
    setDraftTo('');
    setCodeEntry('');
    usedFreeTextRef.current = false;
    applyFilters({});
  }, [applyFilters]);

  const onAddCode = useCallback(() => {
    const code = codeEntry.trim();
    if (!code) return;
    usedFreeTextRef.current = true;
    /*
      Added as ONE value even if it contains a comma, because that is what the
      operator typed and this box asks for a code "exactly as it was set up".

      It will NOT match, and that is worth knowing rather than believing
      otherwise: master's `forwardAllowedQuery` joins repeated params with a
      comma and core's `multiParam` splits on one, so `Not interested, will call
      back` reaches core as two codes and the list comes back empty. Splitting
      here would not help — it would produce the same two codes one hop earlier
      while hiding that the code the reader typed is unfilterable. Making it
      work is a core-then-master change to the filter encoding.
    */
    setDraftCodes((current) => (current.includes(code) ? current : [...current, code]));
    setCodeEntry('');
  }, [codeEntry]);

  // Both helpers count `phone` themselves now — see `isAttemptFiltered`, which
  // records why the exclusion inverted. Deliberately NOT corrected locally: the
  // whole point of that leaf module is that no caller carries its own idea of what
  // a filter means, and a `|| Boolean(filters.phone)` here is how the two drift.
  const filtered = isAttemptFiltered(filters);
  const activeCount = attemptFilterGroupCount(filters);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <p className={styles.privacyNote}>
          {mine
            ? 'Phone numbers are shown in full. There is no export from this view.'
            : 'These are one person’s calls, with phone numbers in full — treat what is on screen '
              + 'as personal data. There is no export from this view.'}
        </p>
        <button
          type="button"
          className={`${spine.actionButton} btn-secondary`}
          onClick={reload}
          disabled={page.status === 'loading'}
          data-testid="attempts-refresh"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <FiltersCard activeCount={activeCount}>
        <fieldset className={styles.chipGroup}>
          <legend className={spine.filterLegend}>What happened</legend>
          <div className={styles.chips}>
            {Object.entries(ATTEMPT_OUTCOME_LABELS).map(([value, label]) => (
              <FilterChip
                key={value}
                label={label}
                checked={draftOutcomes.includes(value)}
                onChange={(checked) =>
                  setDraftOutcomes((current) =>
                    checked ? [...current, value] : current.filter((item) => item !== value),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.chipGroup}>
          <legend className={spine.filterLegend}>Where the call got to</legend>
          <div className={styles.chips}>
            {Object.entries(ATTEMPT_STATE_LABELS).map(([value, label]) => (
              <FilterChip
                key={value}
                label={label}
                checked={draftStates.includes(value)}
                onChange={(checked) =>
                  setDraftStates((current) =>
                    checked ? [...current, value] : current.filter((item) => item !== value),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.chipGroup}>
          <legend className={spine.filterLegend}>Write-up code</legend>
          {/*
            The honesty clause, at full weight rather than in a `title`. Codes are
            operator-configured free text held per campaign, and this list spans
            many campaigns and many catalogs — so no complete option list exists
            client-side, and a bare row of chips would quietly claim otherwise.
            Saying so is what makes the free-text box below read as the way to
            reach anything else rather than as a redundant duplicate of the chips.
          */}
          <p className={styles.groupNote} data-testid="disposition-incomplete-note">
            Your supervisor sets these per campaign, so there is no single list of them. The
            codes below are the ones on the calls loaded so far — type any other one in full.
          </p>
          {/*
            The one code this filter cannot find, named where it would be typed.
            A comma in a code is unfilterable end to end (master joins the
            repeated params with one, core splits on one), and the answer that
            comes back is an EMPTY list — which reads as "you have no calls
            written up that way" rather than as a limit of the encoding. Same
            rule as the sentence above it: a filter that silently returns nothing
            is worse than one that says what it cannot do.
          */}
          <p className={styles.groupNote} data-testid="disposition-comma-note">
            {DISPOSITION_COMMA_NOTE}
          </p>
          {codeOptions.length > 0 && (
            <div className={styles.chips}>
              {codeOptions.map((code) => (
                <FilterChip
                  key={code}
                  label={code}
                  checked={draftCodes.includes(code)}
                  onChange={(checked) =>
                    setDraftCodes((current) =>
                      checked ? [...current, code] : current.filter((item) => item !== code),
                    )
                  }
                />
              ))}
            </div>
          )}
          <div className={styles.codeEntry}>
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Another code</span>
              <span className={spine.inputWrap}>
                <Search size={14} className={spine.inputIcon} aria-hidden="true" />
                <input
                  type="text"
                  className={spine.fieldInput}
                  value={codeEntry}
                  placeholder="Exactly as it was set up"
                  onChange={(event) => setCodeEntry(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    // Enter adds the code; it must not submit anything, because
                    // the filter card is not a form and Apply is a deliberate
                    // second action.
                    event.preventDefault();
                    onAddCode();
                  }}
                  data-testid="disposition-code-entry"
                />
              </span>
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={onAddCode}
              disabled={codeEntry.trim() === ''}
              data-testid="disposition-code-add"
            >
              Add
            </button>
          </div>
        </fieldset>

        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Campaign</span>
            <select
              className={styles.select}
              value={draftCampaign}
              onChange={(event) => setDraftCampaign(event.target.value)}
              data-testid="campaign-filter"
            >
              <option value="">Every campaign</option>
              {campaignOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          {/*
            The same placeholder as the campaign-scoped view, because it is the
            same search: master forwards `phone` on both agent routes, and core
            picks its mode from what was typed — a leading `+` means a complete
            E.164 and is matched exactly, anything else is matched as a suffix. So
            "whole number, or the last few digits" describes what will actually
            happen rather than hedging.
          */}
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Phone number</span>
            <span className={spine.inputWrap}>
              <Search size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="text"
                className={spine.fieldInput}
                value={draftPhone}
                placeholder="Whole number, or the last few digits"
                onChange={(event) => setDraftPhone(event.target.value)}
                data-testid="phone-filter"
              />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>First day</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Last day</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
              />
            </span>
          </label>
        </div>

        {/*
          "First day" / "Last day" rather than "From" / "To", and this note beneath
          them. The words are chosen against the sibling screen: the performance
          page selects named periods with an EXCLUSIVE end on `dialed_at`, this one
          takes two days with an INCLUSIVE end on `created_at`, and borrowing its
          vocabulary would put one label over two meanings on two screens a link
          apart. See `agencyAttemptFilters.ts`, which owns both facts.
        */}
        <p className={styles.groupNote} data-testid="attempts-range-note">
          {ATTEMPT_RANGE_NOTE}
        </p>

        <div className={spine.filterFooter}>
          {invertedRange && (
            <p className={spine.filterError} role="alert" data-testid="attempts-inverted-range">
              <AlertCircle size={13} aria-hidden="true" />
              The first day is after the last day, so nothing could match. Swap them to continue.
            </p>
          )}
          <div className={spine.filterActions}>
            <button type="button" className="btn-primary" onClick={onApply} disabled={invertedRange}>
              Apply
            </button>
            {filtered && (
              <button type="button" className="btn-secondary" onClick={onClear}>
                Clear
              </button>
            )}
          </div>
        </div>
      </FiltersCard>

      {page.status === 'error' && <ErrorAlert message={page.message} onRetry={reload} />}

      {/*
        Mounted UNCONDITIONALLY, the same as the campaign spine's. A screen reader
        only announces an `aria-live` region that was already in the accessibility
        tree when its contents changed; rendered inside the rows block it would
        unmount behind the spinner on every reload and remount full, so the one
        signal that a filter changed anything is the signal least likely to arrive.
      */}
      <p className={spine.count} data-testid="attempts-count" aria-live="polite" aria-atomic="true">
        {page.status === 'ready' && rows.length > 0 && (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {`Showing ${rows.length.toLocaleString()} call${rows.length === 1 ? '' : 's'}`
              + (page.nextCursor ? ' — there are more' : '')}
          </>
        )}
      </p>

      {page.status === 'loading' && <LoadingSpinner />}

      {page.status === 'ready' && rows.length === 0 && (
        /*
          The third absence, and the one a naive render loses. A failed read is
          above this block; a null field on a row is inside the table. THIS is a
          steady state — somebody took no calls in the range they asked about —
          and it must not be dressed as either of the other two. The unfiltered
          copy is second-person or third-person by `subject`, because telling a
          supervisor "you haven't taken any calls" about somebody else is simply
          the wrong sentence.
        */
        <EmptyState
          icon={<PhoneOutgoing size={32} />}
          title={
            filtered
              ? 'No calls match those filters'
              : mine
                ? 'You haven’t taken any calls yet'
                : 'No calls on record for this person'
          }
          description={
            filtered
              ? 'Widen the days or clear the filters to see every call on record.'
              : mine
                ? 'Calls appear here as you take them — including the ones that never connected.'
                : 'Nothing has been dialled under this person’s name yet, on any campaign.'
          }
        />
      )}

      {page.status === 'ready' && rows.length > 0 && (
        <>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Number</th>
                  <th scope="col">Campaign</th>
                  <th scope="col">Try</th>
                  <th scope="col">Where it got to</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Write-up</th>
                  <th scope="col">Talk time</th>
                  {!mine && <th scope="col">Call</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((attempt) => (
                  <AttemptRow
                    key={attempt.id}
                    attempt={attempt}
                    campaignNames={campaignNames}
                    linkToCall={!mine}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {moreError && (
            /*
              Beside the button, not in place of the rows. The rows already on
              screen are still good — replacing them because asking for MORE of
              them failed throws away exactly what the reader came for.
            */
            <p className={styles.moreError} role="alert" data-testid="attempts-more-error">
              {moreError}
            </p>
          )}

          {page.nextCursor && (
            <div className={spine.more}>
              <button
                type="button"
                className="btn-secondary"
                onClick={loadMore}
                disabled={loadingMore}
                data-testid="attempts-load-more"
              >
                {/*
                  "Load older" and never a page number: `next_cursor` is opaque and
                  there is no total, so numbered pages would need a count the API
                  refuses to produce and a cursor they could not jump with.
                */}
                {loadingMore ? 'Loading…' : 'Load older calls'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One dial. */
function AttemptRow({
  attempt,
  campaignNames,
  linkToCall,
}: {
  attempt: AgencyAttempt;
  campaignNames: ReadonlyMap<string, string | null>;
  /** Whether this reader can reach the agency call detail — see the header. */
  linkToCall: boolean;
}) {
  const resolved = campaignNames.get(attempt.campaign_id);
  return (
    <tr data-testid={`my-attempt-row-${attempt.id}`}>
      <td className={styles.when}>{formatSpineTimestamp(attempt.created_at)}</td>
      <td className={styles.numeric}>{attempt.phone_e164}</td>
      <td
        className={resolved ? undefined : styles.mutedCell}
        /* The full id in the title, so a supervisor chasing an unresolvable
           campaign has something to search master's staffing table with. */
        title={resolved ? undefined : attempt.campaign_id}
        data-testid={`my-attempt-campaign-${attempt.id}`}
      >
        {campaignLabel(attempt.campaign_id, campaignNames)}
      </td>
      <td className={styles.numeric}>{attempt.attempt_number}</td>
      <td>{attemptStateLabel(attempt.state)}</td>
      <td>
        <span
          className={styles.outcome}
          data-outcome={attempt.outcome ?? 'unknown'}
          data-testid={`my-attempt-outcome-${attempt.id}`}
        >
          {attemptOutcomeLabel(attempt.outcome)}
        </span>
      </td>
      <td>
        {attempt.disposition_code ?? <span className={styles.mutedCell}>Not written up</span>}
        {attempt.dispositioned_on_behalf && (
          <span
            className={styles.onBehalf}
            title="Filed by someone other than the agent on the call"
          >
            on behalf
          </span>
        )}
        {/* Agent-typed free text, rendered as TEXT — never as markup. Shown
            because it is frequently the answer to "why did this call go that
            way", which is the question somebody reading their own history is
            asking. */}
        {attempt.notes && <span className={styles.notes}>{attempt.notes}</span>}
      </td>
      {/*
        `formatTalkTime` returns an em dash for `null` and `0:00` for a real zero,
        and the difference is load-bearing: `talk_seconds` is null on every call
        that never bridged — abandoned, no answer, failed — which is ordinary
        rather than missing data. Printing `0` there would tell somebody they
        talked to a customer for no time at all, when in truth they never got the
        customer.
      */}
      <td className={styles.numeric} data-testid={`my-attempt-talk-${attempt.id}`}>
        {formatTalkTime(attempt.talk_seconds)}
      </td>
      {linkToCall && (
        <td data-testid={`my-attempt-call-${attempt.id}`}>
          {/*
            Keyed on the ATTEMPT and its own `campaign_id`, which is why this list
            can link at all: the rows here span campaigns, so the destination
            cannot come from the URL the way it does on the campaign-scoped view.

            `recordingCellCopy` decides whether there is anything to open, with the
            same words the campaign attempts view uses — an attempt that never
            produced a media leg has nothing to link to, and that is a fact rather
            than a failure. Whether the CALL still exists is the destination page's
            answer to give (core keeps the id un-FK'd so the attempt outlives it),
            which is exactly why this is a link and never an embedded player.
          */}
          {recordingCellCopy(attempt) === null ? (
            <Link
              to={`/agency/campaigns/${attempt.campaign_id}/attempts/${attempt.id}`}
              className={styles.callLink}
            >
              <Play size={13} aria-hidden="true" />
              Open call
            </Link>
          ) : (
            <span className={styles.mutedCell}>{recordingCellCopy(attempt)}</span>
          )}
        </td>
      )}
    </tr>
  );
}

export default AgentAttemptsPanel;
