import type { AgencyUploadResponse } from '../../../types/agency-campaign';
import { sheetNotice } from '../../../utils/agencyCustomerFile';

/**
 * Which sheet of an Excel upload was read, and the ones that were not (CS7, IM8). Nothing for a
 * CSV. New campaign's Customers step shows it in the file row; Add contacts above the columns.
 * Each page passes its own line styles.
 */
export function SheetNotice({
  upload,
  readClassName,
  othersClassName,
}: {
  upload: Pick<AgencyUploadResponse, 'sheet'> | null | undefined;
  readClassName?: string;
  othersClassName?: string;
}) {
  const copy = sheetNotice(upload);
  if (!copy) return null;
  return (
    <>
      <p className={readClassName} data-testid="sheet-read">{copy.read}</p>
      {copy.others ? (
        <p className={othersClassName} data-testid="sheet-others">{copy.others}</p>
      ) : null}
    </>
  );
}
