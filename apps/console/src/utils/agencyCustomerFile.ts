import type { AgencyUploadResponse } from '../types/agency-campaign';

/**
 * The customer file a campaign takes: CSV, or an Excel workbook (`.xlsx`). New campaign's
 * Customers step and a campaign's Add contacts both offer it, so the picker's list, its label
 * and the sheet notice live here once (CS7; the server's rules are IM8 in `docs/decisions.md`).
 *
 * A legacy `.xls` is not offered: the server refuses it, and says why, when one is dropped.
 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The file input's `accept`: by extension and by type, for browsers that read either. */
export const CUSTOMER_FILE_ACCEPT = ['.csv', 'text/csv', '.xlsx', XLSX_MIME].join(',');

/** The file input's accessible name. */
export const CUSTOMER_FILE_LABEL = 'Excel or CSV file';

/**
 * An uploaded file's name without its `.csv`, `.xlsx` or `.xlsm`, to name a file made from it
 * (`Customers.xlsx` → `Customers`, then `Customers-rejected-rows.csv`). The downloads are CSV
 * whatever was uploaded. The same rule as the server's own download names: it reads a workbook
 * by its content, so a macro workbook (`.xlsm`) the picker does not offer can still be dropped.
 */
export function uploadBaseName(fileName: string): string {
  return fileName.replace(/\.(csv|xlsx|xlsm)$/i, '');
}

export interface SheetNoticeCopy {
  /** "Read from the sheet ‘Customers’." */
  read: string;
  /** The sheets that were not read and what to do about them, or null when there are none. */
  others: string | null;
}

/**
 * What an Excel upload says about its sheets: which one was read (only the first visible sheet
 * is, IM8) and, when the workbook has more, that they were not. Null for a CSV.
 */
export function sheetNotice(
  upload: Pick<AgencyUploadResponse, 'sheet'> | null | undefined,
): SheetNoticeCopy | null {
  const sheet = upload?.sheet;
  if (!sheet) return null;
  const read = `Read from the sheet ‘${sheet.name}’.`;
  const names = sheet.other_sheet_names;
  if (names.length === 0) return { read, others: null };
  // Each name quoted, as the read line quotes its own: a sheet called `North, East` is one sheet.
  const list = names.map((name) => `‘${name}’`).join(', ');
  const others = names.length === 1
    ? `This file has 1 other sheet (${list}) that was not read. To import it, move those customers to the first sheet, or save that sheet as its own file.`
    : `This file has ${names.length} other sheets (${list}) that were not read. To import them, move those customers to the first sheet, or save each sheet as its own file.`;
  return { read, others };
}
