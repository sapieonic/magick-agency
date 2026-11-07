import {
  AGENCY_AUTO_DISPOSITION_OUTCOMES,
  type AgencyAutoDispositionOutcome,
  type AgencyDispositionEntry,
  type AgencyOutcomeDispositions,
} from '../../../types/agency-campaign';
import {
  NO_AUTOMATIC_OUTCOME,
  OUTCOME_DISPOSITIONS_EMPTY_CATALOG,
  OUTCOME_DISPOSITIONS_LEAD,
  OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE,
  OUTCOME_LABELS,
  isAutoDispositionEligible,
  validateOutcomeDispositions,
} from '../../../utils/agencyCampaignConfigForm';
import { dispositionLabel } from '../../../utils/agencySpineCopy';
import { useConfigFieldErrors } from './configFieldErrors';
import styles from './CampaignBehaviourSection.module.css';

/*
  One of the editors `CampaignBehaviourSection` assembles, right under the retries:
  automatic outcomes for unanswered calls (`outcome_dispositions`, decisions OD1–OD8).
  Every rule lives in `utils/agencyCampaignConfigForm.ts`; this is the markup and the
  copy.

  ── Its findings show as soon as they exist ─────────────────────────────────
  The section's other errors arrive on a save attempt or from the server. A finding
  here is usually caused somewhere ELSE on the screen — an outcome removed or set to
  stop calling in the catalog above — so waiting for a save would leave Save disabled
  with nothing on screen saying why. The live check is `validateOutcomeDispositions`,
  the same one a save runs; a save's or the server's message for the same row wins.
*/

interface OutcomeDispositionMapProps {
  mapping: AgencyOutcomeDispositions;
  /** The catalog being edited, which is what a mapping is checked against. */
  dispositions: readonly AgencyDispositionEntry[];
  onChange: (next: AgencyOutcomeDispositions) => void;
  /** The section's field errors (a save's findings and the server's `details`). */
  fieldErrors: Record<string, string>;
}

export function OutcomeDispositionMap({
  mapping,
  dispositions,
  onChange,
  fieldErrors,
}: OutcomeDispositionMapProps) {
  const errors = useConfigFieldErrors({
    ...validateOutcomeDispositions(mapping, dispositions),
    ...fieldErrors,
  });

  // The first entry per code, as the server reads it; a duplicate is the catalog's finding.
  const eligible: AgencyDispositionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of dispositions) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    if (isAutoDispositionEligible(dispositions, entry.code)) eligible.push(entry);
  }

  const set = (outcome: AgencyAutoDispositionOutcome, code: string) => {
    const next: AgencyOutcomeDispositions = { ...mapping };
    if (code === '') delete next[outcome];
    else next[outcome] = code;
    onChange(next);
  };

  return (
    <div data-testid="outcome-dispositions">
      <h3 className={styles.subhead}>Unanswered calls</h3>
      <p className={styles.sectionLead}>{OUTCOME_DISPOSITIONS_LEAD}</p>

      {/*
        The note only while there is nothing to show: a mapping left over on an
        emptied catalog still gets its rows, so its findings have somewhere to be.
      */}
      {dispositions.length === 0 && !Object.values(mapping).some(Boolean) ? (
        <p className={styles.hint} data-testid="outcome-dispositions-empty">
          {OUTCOME_DISPOSITIONS_EMPTY_CATALOG}
        </p>
      ) : (
        <table className={styles.retryTable}>
          <thead>
            <tr>
              <th scope="col">When the call ends</th>
              <th scope="col">File it as</th>
            </tr>
          </thead>
          <tbody>
            {AGENCY_AUTO_DISPOSITION_OUTCOMES.map((outcome) => {
              const field = `outcome_dispositions.${outcome}`;
              const code = mapping[outcome] ?? '';
              /*
                A mapped code the list would not offer (removed from the catalog, or
                now stopping or ending the contact) keeps an option of its own, so the
                select shows what is actually mapped beside the finding about it,
                rather than quietly reading "No automatic outcome" while the mapping
                is still there to be saved.
              */
              const stale = code !== '' && !eligible.some((entry) => entry.code === code);
              const selectId = `outcome-disposition-${outcome}`;
              return (
                <tr key={outcome}>
                  <th scope="row">
                    <label htmlFor={selectId}>{OUTCOME_LABELS[outcome]}</label>
                  </th>
                  <td>
                    <select
                      id={selectId}
                      value={code}
                      onChange={(event) => set(outcome, event.target.value)}
                      aria-describedby={errors.describedBy(field)}
                      aria-invalid={errors.message(field) !== null || undefined}
                    >
                      <option value="">{NO_AUTOMATIC_OUTCOME}</option>
                      {eligible.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                          {entry.label || entry.code}
                        </option>
                      ))}
                      {stale ? (
                        <option value={code}>{`${dispositionLabel(code, dispositions)} (can’t be used)`}</option>
                      ) : null}
                    </select>
                    {errors.render(field)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className={styles.callout} data-testid="outcome-dispositions-switched-off">
        {OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE}
      </p>
    </div>
  );
}
