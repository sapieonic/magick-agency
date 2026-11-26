/**
 * Whether a column's header looks like a phone column's: one rule, read in two places that
 * must agree. The column analysis (`agency-column-analysis.ts`) nudges its phone-column
 * suggestion towards such a header; the Excel upload's conversion (`agency-xlsx.ts`, IM8)
 * writes a whole number in such a column in full digits, whatever the cell's number format
 * (Manas, 2026-11-25), so `9876543210` under `#,##0` imports rather than reading
 * `9,87,65,43,210`. Headers only: the conversion runs before anyone maps a column.
 *
 * A LEAF: no imports. Deliberately loose (`Contact Number`, `Alt mobile`, `Phone No.`, `Tel`;
 * also `Loan Number`): in the analysis it only breaks ties, and in the conversion it only
 * keeps a whole number's digits.
 */
const PHONE_HEADER_HINT = /(phone|mobile|cell|contact|msisdn|number|tel)/i;

export function looksLikePhoneHeader(header: string): boolean {
  return PHONE_HEADER_HINT.test(header);
}
