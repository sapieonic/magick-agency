import type { AgencyUploadResponse } from '../../../types/agency-campaign';
import { sheetNotice } from '../../../utils/agencyCustomerFile';

/**
 * Which sheet of an Excel upload was read, and the ones that were not (CS7, IM8). Nothing for a
 * CSV. New campaign's Customers step shows it in the file row; Add contacts above the columns.
 * A status region, like the step's other notes, so a screen reader says it when the file is read.
 * Each page passes its own styles.
 */
export function SheetNotice({
  upload,
  className,
  readClassName,
  othersClassName,
}: {
  upload: Pick<AgencyUploadResponse, 'sheet'> | null | undefined;
  className?: string;
  readClassName?: string;
  othersClassName?: string;
}) {
  const copy = sheetNotice(upload);
  if (!copy) return null;
  return (
    <div className={className} role="status" data-testid="sheet-notice">
      <p className={readClassName} data-testid="sheet-read">{copy.read}</p>
      {copy.others ? (
        <p className={othersClassName} data-testid="sheet-others">{copy.others}</p>
      ) : null}
    </div>
  );
}
