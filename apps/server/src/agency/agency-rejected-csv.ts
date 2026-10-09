import type { AgencyIngestRejection } from './agency-csv-ingest.js';

/**
 * Serializer for the rejected-rows CSV export.
 *
 * "Nobody fixes 577 rows from a screen; they fix them in Excel and re-upload."
 * So the export is the operator's original columns, unchanged and in the original
 * order, plus one trailing column literally named `_reason`. Anything else — a
 * reshaped file, renamed headers, a different column order — makes the fix-and-
 * re-upload loop harder, which is the entire point of the artifact.
 *
 * Written by hand rather than with a library because `csv-stringify` is not a
 * dependency of this service and adding one to emit five columns of quoted text
 * is not a trade worth making. The quoting rules below are the whole of RFC 4180
 * that matters here.
 *
 * This is a generator so a million rejections stream to S3 without ever being
 * an array in memory — the same constraint that shaped the ingest itself.
 */

/** RFC 4180: quote when the value contains a delimiter, a quote or a newline. */
function escapeCsvValue(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvLine(values: string[]): string {
  return `${values.map(escapeCsvValue).join(',')}\n`;
}

/** The column appended to every rejected-rows export. */
export const REJECTED_REASON_COLUMN = '_reason';

/** The column carrying the uploaded file's line, so the operator can find the row again. */
export const REJECTED_ROW_COLUMN = '_row';

/**
 * Header line for a rejected-rows export.
 *
 * The phone column is emitted first rather than restored to its original index:
 * in a rejects file the number is the thing being fixed, so it belongs where the
 * operator's eye lands. `_row` precedes it so the row can be located in the
 * source file, and `_reason` trails so it reads as an annotation.
 *
 * @param phoneColumn    the mapped phone column's header
 * @param contextColumns the retained (non-phone, non-ignored) columns, in file order
 */
export function rejectedCsvHeader(phoneColumn: string, contextColumns: string[]): string {
  return toCsvLine([REJECTED_ROW_COLUMN, phoneColumn, ...contextColumns, REJECTED_REASON_COLUMN]);
}

export function rejectedCsvRow(
  rejection: AgencyIngestRejection,
  contextColumns: string[],
): string {
  return toCsvLine([
    String(rejection.row_number),
    rejection.raw_value,
    // Read from `context`, not from the rejection's own fields, so an ignored
    // column stays ignored here too — otherwise the export becomes the PII leak
    // the operator's `Ignore` mapping existed to prevent.
    ...contextColumns.map((column) => rejection.context[column] ?? ''),
    rejection.reason,
  ]);
}

/**
 * Stream a complete rejected-rows CSV.
 *
 * `rejections` is an async iterable rather than an array so the caller can pipe
 * straight from the ingest's `onRejected` callback into object storage.
 */
export async function* renderRejectedCsv(
  phoneColumn: string,
  contextColumns: string[],
  rejections: AsyncIterable<AgencyIngestRejection> | Iterable<AgencyIngestRejection>,
): AsyncGenerator<string> {
  yield rejectedCsvHeader(phoneColumn, contextColumns);
  for await (const rejection of rejections) {
    yield rejectedCsvRow(rejection, contextColumns);
  }
}
