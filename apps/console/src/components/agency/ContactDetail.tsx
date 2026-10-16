import { useMemo, useState, type RefObject } from 'react';
import { fieldMatchesFilter, highlightSegments } from '../../utils/agencyFieldFilter';
import type { ResolvedContext } from '../../utils/agencyContext';
import type { AgencyDisposition, AgencyReservedAttempt } from '../../types/agency';
import { PriorAttemptsList } from './PriorAttemptsList';
import styles from './AgentStation.module.css';

/**
 * Column 2 — the contact's uploaded fields, the field filter, and the prior
 * attempts.
 *
 * **Keyed on the panel's attempt id** by `AgentConsolePage`.
 */
export function ContactDetail({
  attempt,
  resolved,
  currentCatalog,
  filterInputRef,
}: {
  attempt: AgencyReservedAttempt;
  resolved: ResolvedContext;
  currentCatalog: AgencyDisposition[] | undefined;
  /** The page's `/` shortcut focuses the filter through this. */
  filterInputRef: RefObject<HTMLInputElement>;
}) {
  /**
   * The filter clears on the next `reserved` event, not on every render
   * of the contact panel — and **not at hangup**. This component is keyed on
   * the panel's attempt id by the page, so a new contact mounts it fresh; that
   * replaced an effect that cleared the filter on the same key.
   *
   * Keyed on the **panel's** attempt rather than `live`'s, because `live` has a
   * fourth writer this comment used to deny: `reserved` sets it, `bridged` and
   * `ready` replace it, and **`released` clears it** (`stationReducer`'s
   * `released`). Keyed on `live?.attempt.attempt_id` the id therefore went
   * `att-1 → undefined` the moment the customer hung up, clearing the filter
   * while `panelAttempt` — `live?.attempt ?? retainedAttempt` —
   * still showed that same contact for the whole wrap-up window. An agent who had
   * filtered to find a policy number lost the query at exactly the moment they
   * started writing the note that quotes it.
   *
   * `panelAttempt.attempt_id` is that event and not a proxy for it: the `released`
   * handler retains the same attempt in the same task it clears `live` in, so the
   * key does not move across a wrap-up; it moves when a genuinely different
   * contact arrives. (On a `released` with `requires_disposition: false` nothing is
   * retained and the key does go to `undefined` — correct there, since the panel
   * has already given the contact up and there is no note to write.)
   *
   * Without any of this a filter left over from the last call could hide 38 of the
   * next contact's fields the moment the panel repopulates.
   */
  // matches header and value, case-insensitive, substring, as you type.
  const [fieldFilter, setFieldFilter] = useState('');

  /**
   * Scoped to tier 2 (`resolved.fields`) only — the hero row is capped at
   * four and always visible, and the empty-field disclosure is already collapsed
   * to one summary row, so neither is the "40 rows is scan cost" problem this
   * filter exists to solve.
   */
  const filteredFields = useMemo(
    () => resolved.fields.filter((field) => fieldMatchesFilter(field, fieldFilter)),
    [resolved, fieldFilter],
  );

  return (
    <>
      {/*
        ── The empty state covers the FIELDS, not the column ───────────
        This branch used to wrap the prior-attempt history too, so a
        contact whose uploaded columns were all claimed by the hero row —
        a phone number and a name, the commonest roster there is — showed
        no history at all, under copy claiming it had "only a phone
        number". Both halves were wrong: it has a name, and it may have
        been called four times.

        That was survivable while history could only come from this
        campaign and the panel had other ways to hint at it. It stopped
        being survivable when history began spanning a retry lineage,
        because on a retry campaign the prior attempts ARE the reason the
        agent is being told anything about this contact. So the sentence
        now describes the field list it was always about, and the history
        renders beside it either way.
      */}
      {resolved.fields.length === 0 && resolved.empty.length === 0 ? (
        /*
          "no extra details", not "only a phone number". The list can be
          empty because the contact's name was consumed by the hero row
          above — the common phone-plus-name contact — so the old sentence
          was a plain falsehood on the most ordinary roster there is. What
          is actually true is that this PANEL has nothing more to add,
          which is what it now says.
        */
        <p className={styles.emptyState}>
          No extra details were uploaded for this contact.
        </p>
      ) : (
        <>
          {/*
            Present whenever there is a tier-2 list to search —
            "the filter box is present at all densities, so the gesture is
            the same every time" — but not when the panel has nothing to
            filter (0 non-empty fields), which would only invite typing
            into a box that can never show a result.
          */}
          {resolved.fields.length > 0 ? (
            <div className={styles.fieldFilter}>
              <label className={styles.fieldFilterLabel} htmlFor="agency-field-filter">
                Filter fields
                <span className={styles.fieldFilterKey} aria-hidden="true">
                  /
                </span>
              </label>
              <input
                id="agency-field-filter"
                ref={filterInputRef}
                type="text"
                className={styles.fieldFilterInput}
                value={fieldFilter}
                placeholder="Type to find a field…"
                aria-describedby="agency-field-filter-count"
                onChange={(event) => setFieldFilter(event.target.value)}
                onKeyDown={(event) => {
                  // Esc clears AND blurs — the page's global handler never
                  // sees this key while focus is in here (it returns early
                  // on `inTextField`), so this is the only place it can be
                  // handled, same shape as `NotesField`'s own Escape.
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setFieldFilter('');
                  event.currentTarget.blur();
                }}
              />
              <p id="agency-field-filter-count" className={styles.fieldFilterCount}>
                {fieldFilter
                  ? `${filteredFields.length} of ${resolved.fields.length} field${resolved.fields.length === 1 ? '' : 's'}`
                  : `${resolved.fields.length} field${resolved.fields.length === 1 ? '' : 's'}`}
              </p>
            </div>
          ) : null}

          {/* A definition list, not a table: these are label/value pairs,
              and a table implies row/column relationships that do not
              exist. */}
          {filteredFields.length > 0 ? (
            <dl className={styles.fieldList}>
              {filteredFields.map((field) => (
                <div key={field.label} className={styles.field}>
                  <dt className={styles.fieldLabel} title={field.label} aria-label={field.label}>
                    <HighlightedText text={field.label} query={fieldFilter} />
                  </dt>
                  {/* Rendered as TEXT, always. `context` is operator-uploaded
                      file content and is never markup — `HighlightedText`
                      only ever wraps slices of that same text in `<mark>`,
                      it never interprets it. */}
                  <dd className={styles.fieldValue}>
                    <HighlightedText text={field.value} query={fieldFilter} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : resolved.fields.length > 0 ? (
            // Not absence — the filter is why nothing is showing, and the
            // query that caused it is named so the agent knows to change it
            // rather than assume the contact has nothing left to show.
            <p className={styles.fieldFilterEmpty} data-testid="field-filter-empty">
              No fields match “{fieldFilter}”.
            </p>
          ) : null}
          {resolved.empty.length > 0 ? (
            <details className={styles.emptyFields}>
              <summary>
                {resolved.empty.length} empty field
                {resolved.empty.length === 1 ? '' : 's'}
              </summary>
              <dl className={styles.fieldList}>
                {resolved.empty.map((field) => (
                  <div key={field.label} className={styles.field}>
                    <dt className={styles.fieldLabel}>{field.label}</dt>
                    <dd className={styles.fieldValue}>—</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </>
      )}
      <PriorAttemptsList attempt={attempt} currentCatalog={currentCatalog} />
    </>
  );
}

/**
 * "matching characters are marked". `highlightSegments` does the
 * matching (pure, tested on its own); this wraps each matched slice in a
 * `<mark>` and leaves the rest as plain text.
 *
 * Never touches HTML in `text` — it only slices the string `agencyContext`
 * already stringified and never re-parses it, so's "value contains
 * HTML/markup: rendered as text, always" holds through the filter exactly as
 * it did without one.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index} className={styles.filterMatch}>
            {segment.text}
          </mark>
        ) : (
          // No wrapper needed for the common (no-match) case — a lone unmatched
          // segment renders as a plain string, not an extra span nobody asked for.
          segment.text
        ),
      )}
    </>
  );
}
