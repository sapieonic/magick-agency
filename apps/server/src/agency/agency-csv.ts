/**
 * CSV primitives shared by every agency export.
 *
 * A LEAF module — no imports, no I/O. Extracted from `agency-activity.ts` when
 * MAG-159 added a second and third export (attempts, roster) to MAG-158's first
 * (the activity trail).
 *
 * ── Why extracted rather than copied ────────────────────────────────────────
 * `guardFormulaSigil` is a security control, not formatting. These files
 * predictably leave the organisation and are opened by someone outside it, and
 * a second copy of an injection guard is how one copy goes stale: the copy that
 * was not updated still looks like it is defending something. One definition,
 * one place to fix.
 */

/** The characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_SIGIL = /^[=+\-@\t\r]/;

/**
 * The spreadsheet-formula guard, applied to ONE cell's worth of text.
 *
 * A leading `=`, `+`, `-`, `@`, tab or CR makes Excel/Sheets treat the cell as a
 * formula on open. These exports carry tenant-controlled text — display names,
 * emails, agent-typed notes, verbatim CSV column values — and they are
 * compliance artifacts opened outside the organisation. Prefixing an apostrophe
 * is the standard neutralisation: it is not shown as data by any spreadsheet and
 * round-trips through a CSV parser as a literal character, so the value stays
 * legible either way.
 *
 * ── Leading spaces are tested through, and that is not pedantry ─────────────
 * The sigil is looked for after any leading SPACES, because a spreadsheet
 * classifies the cell after trimming them — Google Sheets and LibreOffice both
 * do, and `Q3, =SUM(A1:A9)` (the comma-and-space spelling a human actually
 * types) is the realistic hostile value, not `Q3,=SUM(...)`. A guard that only
 * looked at character zero would pass it straight through. The apostrophe is
 * still prefixed at position zero, ahead of the spaces, because that is the
 * position at which a spreadsheet reads it as the text marker.
 */
export function guardFormulaSigil(cell: string): string {
  return FORMULA_SIGIL.test(cell.replace(/^ +/, '')) ? `'${cell}` : cell;
}

/**
 * RFC 4180 quoting, plus the formula guard above.
 *
 * The comma-split hole that {@link sanitizePreambleValue} has to close by hand
 * does NOT exist here: a value containing a comma is quoted, so a parser reads
 * the whole thing back as one cell and there is no second, unguarded cell for a
 * sigil to land in. Quoting is what makes the single leading-position guard
 * sufficient — which is exactly why the preamble, being unquoted, cannot reuse
 * it unchanged.
 */
export function escapeCsvValue(value: string): string {
  if (value === '') return '';
  const guarded = guardFormulaSigil(value);
  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function toCsvLine(values: string[]): string {
  return `${values.map(escapeCsvValue).join(',')}\n`;
}

/**
 * Strips what a `#` comment line cannot survive, then applies the same
 * leading-character guard as {@link escapeCsvValue}.
 *
 * A preamble line is raw text ending at the next `\n` the writer emits, not a
 * quoted RFC-4180 field — there is no closing quote to contain an embedded
 * newline. A campaign named `"Q3\n=SUM(A1:A9),1000000"` would otherwise end
 * the current `#` line early and start a new, un-prefixed line of
 * attacker-chosen text: one forged preamble line, or — with a second
 * newline — a fabricated row ahead of the real header. CR/LF is therefore
 * stripped outright rather than escaped; there is no safe way to keep it.
 *
 * ── The formula guard is applied PER COMMA-DELIMITED FIELD, not once ────────
 * It needs its own justification at all, because a preamble line always starts
 * with `#` and a spreadsheet reading the WHOLE line as one cell is already
 * inert. But the line is not comma-quoted either, so a value containing a comma
 * splits into further, independently-classified cells when a spreadsheet parses
 * the row.
 *
 * `Q3, =SUM(A1:A9)` as a campaign name is the case, and it is the one a guard
 * tested against the START of the whole value silently misses: the value begins
 * with `Q`, so nothing is prefixed, the line is emitted as
 * `# Campaign: Q3, =SUM(A1:A9)`, and the second cell holds a live formula.
 * Guarding every field the split can produce is what actually closes it.
 *
 * Splitting rather than **forbidding** commas is deliberate: a campaign name is
 * the operator's own text and a compliance export that quietly mangled it would
 * be answering a chain-of-custody question with a different name than the one on
 * the screen. The comma stays; only the sigil behind it is neutralised.
 */
export function sanitizePreambleValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .split(',')
    .map(guardFormulaSigil)
    .join(',');
}

export function preambleLine(text: string): string {
  return `# ${text}\n`;
}
