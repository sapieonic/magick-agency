import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import { AUTO_DISPOSITION_HINT, autoDispositionLabel } from '../../utils/agencySpineCopy';
import styles from './AutoDisposition.module.css';

/**
 * An attempt's automatic outcome (`auto_disposition_code`, decisions OD1–OD8), tagged as
 * such: "Retry later (automatic)", with what filed it on hover. Renders nothing when
 * there is none.
 *
 * `secondary` is for an attempt that also carries a person's write-up: the write-up
 * is the disposition, and this sits under it, smaller.
 *
 * `catalog` is the campaign's own, when the view has it; without one the code is
 * shown, as `dispositionLabel` falls back everywhere else.
 */
export function AutoDisposition({
  code,
  catalog,
  secondary = false,
  testId,
}: {
  code: string | null | undefined;
  catalog?: readonly AgencyDispositionEntry[];
  secondary?: boolean;
  testId?: string;
}) {
  const label = autoDispositionLabel(code, catalog);
  if (label === null) return null;
  return (
    <span
      className={secondary ? `${styles.auto} ${styles.secondary}` : styles.auto}
      title={AUTO_DISPOSITION_HINT}
      data-auto-disposition={secondary ? 'secondary' : 'primary'}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
