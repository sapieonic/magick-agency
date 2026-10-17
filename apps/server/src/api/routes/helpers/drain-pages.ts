/**
 * Drain a cursor-paginated read into CSV lines, under a row ceiling and a wall-clock
 * budget — the loop the campaign activity export and the two spine exports share.
 *
 * Everything that is hard about these exports is here once, so the copies cannot drift:
 *  - the ceiling: rows past `maxRows` are not rendered, and the drain stops with
 *    `row_limit` only when a row beyond the ceiling actually existed;
 *  - the budget: checked BETWEEN pages, after a page is written and only when there is
 *    a next page — never before the first fetch, because a budget that could expire on
 *    entry would answer a truncated empty file to a request that had done no work;
 *  - a page that cannot be read: `fetchPage` throws, and the drain stops there with
 *    nothing returned, so a half-written file never reaches a 200.
 *
 * The lines are returned rather than streamed: the file's preamble, its row count and
 * truncation headers are only known once the drain has finished, and a refused page
 * must still be able to answer its own status instead of a short file.
 */
export interface DrainedPages<TTruncation extends string> {
  /** The header line, then one line per row. */
  lines: string[];
  rowCount: number;
  truncated: 'row_limit' | TTruncation | null;
}

export async function drainPages<TCursor, TRow, TTruncation extends string>(params: {
  /** The cursor of the first page (`null` where the read takes none). */
  first: TCursor | null;
  /** One page: its rows and the next page's cursor, `null` (or absent) on the last. */
  fetchPage: (cursor: TCursor | null) => Promise<{ rows: readonly TRow[]; next: TCursor | null }>;
  header: string;
  renderRow: (row: TRow) => string;
  maxRows: number;
  budgetMs: number;
  /** The truncation reported when the budget ran out (`'deadline'`, `'time_limit'`). */
  deadlineReason: TTruncation;
  /** Called once when the budget runs out, with the rows written so far. */
  onDeadline: (rowCount: number) => void;
}): Promise<DrainedPages<TTruncation>> {
  const lines: string[] = [params.header];
  let rowCount = 0;
  let truncated: 'row_limit' | TTruncation | null = null;
  let cursor = params.first;
  const deadline = Date.now() + params.budgetMs;

  for (;;) {
    // No per-page budget: the deadline below is checked between pages.
    const page = await params.fetchPage(cursor);
    for (const row of page.rows) {
      if (rowCount >= params.maxRows) {
        truncated = 'row_limit';
        break;
      }
      lines.push(params.renderRow(row));
      rowCount += 1;
    }
    if (truncated) break;

    cursor = page.next;
    if (!cursor) break;
    if (Date.now() >= deadline) {
      params.onDeadline(rowCount);
      truncated = params.deadlineReason;
      break;
    }
  }

  return { lines, rowCount, truncated };
}
