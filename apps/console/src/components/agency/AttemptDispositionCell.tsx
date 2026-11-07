import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import type { AgencyAttempt } from '../../types/agency-spine';
import { dispositionLabel } from '../../utils/agencySpineCopy';
import { SYSTEM_DISPOSITION_HINTS, isSystemDispositionCode } from '../../utils/agency/systemDisposition';
import { AutoDisposition } from './AutoDisposition';
import styles from './AttemptDispositionCell.module.css';

/**
 * The disposition cell of an attempt table (the agent's own attempts, a campaign's
 * attempts, a contact's attempts): the contents of the `<td>`, which the caller owns.
 *
 * - A code the SYSTEM wrote (`redialed`) is named and styled as the system's record,
 *   with what wrote it on hover.
 * - A person's write-up is the catalog label (or the code, by `dispositionLabel`'s
 *   fallbacks), then "on behalf" when someone other than the agent on the call filed it.
 * - The campaign's unanswered-call mapping (`auto_disposition_code`, OD1–OD8) is
 *   shown tagged automatic: under the write-up when there is one, and in place of the
 *   `placeholder` when there is not.
 *
 * `catalog` is the campaign's own, when the view has one; without it a code is shown
 * as the code. `testIdPrefix` names the automatic outcome's test id,
 * `<prefix>-auto-disposition-<attempt id>`.
 */
export function AttemptDispositionCell({
  attempt,
  catalog,
  placeholder,
  testIdPrefix,
}: {
  attempt: Pick<AgencyAttempt, 'id' | 'disposition_code' | 'auto_disposition_code' | 'dispositioned_on_behalf'>;
  catalog?: readonly AgencyDispositionEntry[];
  /** What the cell says when there is neither a write-up nor an automatic outcome. */
  placeholder: string;
  testIdPrefix: string;
}) {
  const code = attempt.disposition_code;
  return (
    <>
      {isSystemDispositionCode(code) ? (
        <span className={styles.muted} title={SYSTEM_DISPOSITION_HINTS[code]} data-system-disposition="">
          {dispositionLabel(code, catalog)}
        </span>
      ) : (
        dispositionLabel(code, catalog)
          ?? (attempt.auto_disposition_code ? null : <span className={styles.muted}>{placeholder}</span>)
      )}
      {attempt.dispositioned_on_behalf && (
        <span className={styles.onBehalf} title="Filed by someone other than the agent on the call">
          on behalf
        </span>
      )}
      <AutoDisposition
        code={attempt.auto_disposition_code}
        catalog={catalog}
        secondary={code !== null}
        testId={`${testIdPrefix}-auto-disposition-${attempt.id}`}
      />
    </>
  );
}
