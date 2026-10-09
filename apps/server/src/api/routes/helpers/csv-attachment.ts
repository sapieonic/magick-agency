/**
 * Building the `Content-Disposition` header for a CSV export.
 *
 * The export routes interpolated a campaign name straight into the header:
 *
 *     reply.header('Content-Disposition', `attachment; filename="${jobName}.csv"`)
 *
 * `bulk_dispatch_jobs.name` is caller-supplied and validated as a passthrough
 * string with no character restriction, so that had two failure modes and no
 * good one. A campaign named `Q3 "priority" list` closed the quoted string
 * early and browsers took the filename as `Q3 `. A name carrying CR or LF was
 * worse: Node rejects a header value containing them with `ERR_INVALID_CHAR`,
 * which escapes as a 500 and is then masked into "contact support" — so an
 * export was unavailable for the life of the campaign, with nothing in the
 * response naming the cause.
 *
 * Two headers' worth of answer, per RFC 6266:
 *   - `filename=` carries an ASCII-only, quote-free fallback for old clients.
 *   - `filename*=UTF-8''…` carries the real name percent-encoded, so a campaign
 *     named in Hindi or Arabic downloads under its own name.
 * Every modern browser prefers `filename*` when both are present.
 */

/** Characters that terminate or reinterpret a quoted header value. */
const UNSAFE_ASCII = /["\\]/g;
/** Anything outside printable ASCII, including the CR/LF that throw. */
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g;
/** Long enough for any real campaign name, short of filesystem limits. */
const MAX_FILENAME_LENGTH = 120;

/**
 * Truncate by Unicode CODE POINT, never by `String.prototype.slice`.
 *
 * `slice` counts UTF-16 code units, so a cut landing between the two halves of
 * a surrogate pair leaves a lone surrogate -- and `encodeURIComponent` throws
 * `URIError: URI malformed` on one. Measured: 119 ASCII characters followed by
 * a single emoji is enough. That throw escapes the export handler as a 500 and
 * `errorMaskHook` rewrites it into "contact support", which is the exact
 * failure this module was written to remove, arrived at one step along.
 *
 * The spread also means the budget is counted in characters a person would
 * recognise, so a 120-emoji name keeps 120 emoji rather than 60.
 */
function truncateCodePoints(raw: string, max: number): string {
  const points = [...raw];
  return points.length <= max ? raw : points.slice(0, max).join('');
}

/**
 * The ASCII fallback: quote-safe, control-character-free, never empty.
 *
 * A name that is ENTIRELY non-ASCII (a campaign titled only in Devanagari)
 * sanitises to nothing, so it falls back to `export` rather than producing
 * `filename=".csv"` — the `filename*` parameter still carries the real name.
 */
export function asciiFallbackName(raw: string): string {
  const cleaned = raw
    .replace(UNSAFE_ASCII, '')
    .replace(NON_PRINTABLE_ASCII, '')
    .trim();
  // ASCII-only by this point, so no surrogate can survive to be split -- but it
  // goes through the same helper so the two names are cut to one budget and a
  // later change to the character filter cannot silently reintroduce the split.
  const bounded = truncateCodePoints(cleaned, MAX_FILENAME_LENGTH).trim();
  return bounded.length > 0 ? bounded : 'export';
}

/**
 * A complete `Content-Disposition` value for a CSV download.
 *
 * `baseName` is the name WITHOUT the extension — the `.csv` is appended here so
 * no call site can forget it or double it.
 */
export function csvAttachmentHeader(baseName: string): string {
  const ascii = `${asciiFallbackName(baseName)}.csv`;
  // encodeURIComponent leaves !'()* alone, and `'` is a delimiter in the
  // ext-value grammar, so those are encoded by hand.
  const encoded = encodeURIComponent(`${truncateCodePoints(baseName, MAX_FILENAME_LENGTH)}.csv`)
    .replace(/['()!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
