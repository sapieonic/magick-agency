/**
 * The station's in-tab diagnostics buffer: bridge `status`/`ended` frames, the
 * cue lag, `campaign_state`, errors, closes, a discarded disposition.
 *
 * ── Why this is not React state ──────────────────────────────────────────────
 * It used to be a `useState` array in `useAgencyStation`, copied (up to the whole
 * 200 entries) into a new array on every diagnostic frame — and nothing renders
 * it. So every bridge `status` frame re-rendered the entire console to update a
 * value no pixel reads. Two writers also pushed straight into that state array
 * (the console's discarded-disposition entry and the cue dispatcher's lag line),
 * mutating React state in place, which is a write React never sees.
 *
 * A plain object held in a ref has neither defect: appending costs no render, and
 * in-place mutation is what it is for. `entries` keeps **one identity for the
 * life of the log**, so a reader holding it — a test, a future diagnostics panel
 * — always reads the current contents.
 *
 * Bounded so an eight-hour shift cannot grow it without limit: past the limit the
 * oldest entries are dropped, ring-buffer fashion. It never leaves the browser.
 */

export interface DiagnosticEntry {
  at: number;
  attemptId: string | null;
  event: string;
  detail: string;
}

/** Bounded so an eight-hour shift cannot grow it without limit. */
export const DIAGNOSTIC_LIMIT = 200;

/** What a writer needs. The cue dispatcher and the console write; only tests read. */
export interface DiagnosticsSink {
  push(entry: DiagnosticEntry): void;
}

export class DiagnosticsLog implements DiagnosticsSink {
  /** Oldest first, newest last. Same array for the life of the log. */
  readonly entries: DiagnosticEntry[] = [];

  constructor(private readonly limit: number = DIAGNOSTIC_LIMIT) {}

  push(entry: DiagnosticEntry): void {
    this.entries.push(entry);
    const excess = this.entries.length - this.limit;
    if (excess > 0) this.entries.splice(0, excess);
  }
}
