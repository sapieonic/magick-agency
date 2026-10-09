import { describe, it, expect } from 'vitest';
import {
  buildIngestSummary,
  terminalNotice,
  isTerminal,
  HIGH_REJECTION_RATIO,
  REJECTION_LABELS,
} from '../../utils/agencyIngestSummary';
import type { AgencyIngestJob } from '../../types/agency-campaign';

/**
 * `AD-P3-U-01` acceptance (b): *the counts are displayed and reconcile to the
 * file's row count*.
 *
 * The arithmetic under test is `accepted + rejected = rows_read`, with
 * `duplicates` and `dnc_suppressed` as **breakdowns of `rejected`**. That is the
 * shape master actually produces — a duplicate row goes through the same
 * `reject()` as every other rejection, and DNC-listed rows are moved from
 * accepted to rejected rather than counted a third way.
 */

function job(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return {
    job_id: 'job-1',
    campaign_id: 'camp-1',
    status: 'completed',
    dry_run: false,
    file_name: 'collections_aug.csv',
    progress_pct: 100,
    rows_read: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    rejected_by_reason: {},
    core_rejected_duplicate_rows: 0,
    core_duplicate_source_rows: [],
    chunks_sent: 0,
    headers: null,
    context_columns: null,
    has_rejected_export: false,
    rejected_row_count: 0,
    rejected_truncated: false,
    error_code: null,
    error_message: null,
    created_at: '2026-08-11T10:00:00.000Z',
    started_at: '2026-08-11T10:00:01.000Z',
    finished_at: '2026-08-11T10:04:00.000Z',
    ...over,
  };
}

/**
 * The operator's own file: 12,481 data rows, of which 192 are repeats of a
 * number seen earlier and 41 are on the DNC list. Every one of those 233 is a
 * rejection, so the two addends are 11,712 and 769.
 */
const OPERATOR_FILE = job({
  rows_read: 12_481,
  accepted: 11_712,
  rejected: 769,
  duplicates: 192,
  rejected_by_reason: {
    invalid_phone: 412,
    duplicate_phone: 192,
    missing_phone_value: 124,
    dnc_suppressed: 41,
  },
  has_rejected_export: true,
  rejected_row_count: 769,
});

describe('the summary reconciles against a spreadsheet', () => {
  it('adds accepted + rejected to exactly the rows read', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    const rowsRead = summary.counters.find((c) => c.key === 'rows_read')!.value;
    const accepted = summary.counters.find((c) => c.key === 'accepted')!.value;
    const rejected = summary.counters.find((c) => c.key === 'rejected')!.value;

    expect(accepted + rejected).toBe(rowsRead);
    expect(summary.reconciles).toBe(true);
  });

  it('does NOT present duplicates as a third addend', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    // The failure this pins: a fourth tile that an operator adds in, producing
    // 12,673 against a 12,481-row file. Duplicates are reported, but never as a
    // counter that participates in the sum.
    expect(summary.counters.map((c) => c.key)).toEqual(['rows_read', 'accepted', 'rejected']);

    // The addends are exactly the two that are not `rows_read`, and adding
    // duplicates to them overshoots the file — which is the whole reason
    // duplicates is not one of them.
    const addends = summary.counters.filter((c) => c.key !== 'rows_read');
    expect(addends.reduce((n, c) => n + c.value, 0)).toBe(OPERATOR_FILE.rows_read);
    expect(addends.reduce((n, c) => n + c.value, 0) + summary.duplicates).toBeGreaterThan(
      OPERATOR_FILE.rows_read,
    );
    expect(summary.duplicates).toBe(192);
  });

  it('counts duplicates and DNC suppressions INSIDE the rejected total', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    const rejected = summary.counters.find((c) => c.key === 'rejected')!.value;
    const grouped = summary.groups.reduce((n, g) => n + g.count, 0);

    // Every group is a slice of `rejected`, and together they account for all of
    // it. If duplicates were outside the rejected total this sum would be 577.
    expect(grouped).toBe(rejected);
    expect(summary.groups.find((g) => g.code === 'duplicate_phone')!.count).toBe(192);
    expect(summary.dncSuppressed).toBe(41);
  });

  it('states the identity in words, with the real numbers', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    expect(summary.reconciliationLine).toContain('11,712 accepted');
    expect(summary.reconciliationLine).toContain('769 rejected');
    expect(summary.reconciliationLine).toContain('12,481 rows read');
  });

  it('reports a payload that does not balance rather than papering over it', () => {
    // Not hypothetical bookkeeping: a job polled mid-run has counters that lag
    // each other, and the screen must not claim a reconciliation it does not have.
    const summary = buildIngestSummary(job({ rows_read: 100, accepted: 40, rejected: 30 }));
    expect(summary.reconciles).toBe(false);
  });
});

describe('the DNC notice', () => {
  it('names the suppression AND says it sits inside the rejected total', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    // Conflating a compliance suppression with a parse error is a
    // compliance-reporting problem, so it is called out separately — but an
    // operator balancing the tiles has to know which addend it landed in.
    expect(summary.dncNotice).toContain('41');
    expect(summary.dncNotice).toContain('Do Not Call');
    expect(summary.dncNotice).toContain('rejected total');
  });

  it('is absent when nothing was suppressed', () => {
    expect(buildIngestSummary(job({ rows_read: 5, accepted: 5 })).dncNotice).toBeNull();
  });

  it('is singular for one suppression', () => {
    const summary = buildIngestSummary(
      job({ rows_read: 5, accepted: 4, rejected: 1, rejected_by_reason: { dnc_suppressed: 1 } }),
    );
    expect(summary.dncNotice).toContain('1 number is');
    expect(summary.dncNotice).not.toContain('numbers are');
  });
});

describe('rejection groups', () => {
  it('orders by count, largest first, and labels every code', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    expect(summary.groups.map((g) => g.count)).toEqual([412, 192, 124, 41]);
    expect(summary.groups.map((g) => g.label)).toEqual([
      REJECTION_LABELS.invalid_phone,
      REJECTION_LABELS.duplicate_phone,
      REJECTION_LABELS.missing_phone_value,
      REJECTION_LABELS.dnc_suppressed,
    ]);
  });

  it('breaks count ties on the code so the order does not shuffle between polls', () => {
    const summary = buildIngestSummary(
      job({
        rows_read: 4,
        accepted: 0,
        rejected: 4,
        rejected_by_reason: { ragged_row: 2, invalid_phone: 2 },
      }),
    );
    expect(summary.groups.map((g) => g.code)).toEqual(['invalid_phone', 'ragged_row']);
  });

  it('renders an unknown code rather than dropping its rows from the list', () => {
    // A reason master adds later must not silently vanish from a screen whose
    // groups are supposed to account for the whole rejected total.
    const summary = buildIngestSummary(
      job({
        rows_read: 2,
        accepted: 1,
        rejected: 1,
        rejected_by_reason: { future_reason: 1 } as never,
      }),
    );
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.label).toBe('Rejected for another reason');
  });

  it('drops zero-count reasons', () => {
    const summary = buildIngestSummary(
      job({ rows_read: 1, accepted: 1, rejected_by_reason: { invalid_phone: 0 } }),
    );
    expect(summary.groups).toEqual([]);
  });
});

describe('the high-rejection warning', () => {
  it('fires exactly AT the threshold, not only above it', () => {
    const atThreshold = job({
      rows_read: 1000,
      accepted: 1000 - 1000 * HIGH_REJECTION_RATIO,
      rejected: 1000 * HIGH_REJECTION_RATIO,
    });
    const summary = buildIngestSummary(atThreshold);
    expect(summary.rejectionRatio).toBe(HIGH_REJECTION_RATIO);
    expect(summary.highRejectionWarning).toContain('20%');
    expect(summary.highRejectionWarning).toContain('phone number');
  });

  it('stays quiet one row below the threshold', () => {
    const summary = buildIngestSummary(job({ rows_read: 1000, accepted: 801, rejected: 199 }));
    expect(summary.highRejectionWarning).toBeNull();
  });

  it('does not divide by zero on an empty file', () => {
    const summary = buildIngestSummary(job({ rows_read: 0, accepted: 0, rejected: 0 }));
    expect(summary.rejectionRatio).toBe(0);
    expect(summary.highRejectionWarning).toBeNull();
  });
});

/**
 * What core refused on arrival.
 *
 * `accepted`/`rejected` are master's count of what it decided to SEND; this is
 * core's count of what it would not TAKE. They are measured on opposite sides of
 * a network hop, so they cannot be reconciled — and `MAG-113` is the record of
 * what happens when a summary claims an arithmetic the payload cannot support.
 */
describe('rows core refused on arrival', () => {
  const REUPLOAD = job({
    rows_read: 5_000,
    accepted: 4_800,
    rejected: 200,
    rejected_by_reason: { invalid_phone: 200 },
    core_rejected_duplicate_rows: 1_204,
    core_duplicate_source_rows: [3, 8, 12, 19],
  });

  it('is not an addend, and does not disturb the identity that is', () => {
    const summary = buildIngestSummary(REUPLOAD);
    // The failure this pins: 1,204 folded into `rejected` (or into the tiles)
    // against a 5,000-row file, producing a screen that cannot be balanced.
    expect(summary.counters.map((c) => c.key)).toEqual(['rows_read', 'accepted', 'rejected']);
    expect(summary.counters.find((c) => c.key === 'rejected')!.value).toBe(200);
    expect(summary.reconciles).toBe(true);
    // Nor a rejection group — those are all slices of `rejected`.
    expect(summary.groups.map((g) => g.code)).toEqual(['invalid_phone']);
    expect(summary.coreRefused).toBe(1_204);
  });

  it('states it as a floor, because master’s own count can undercount', () => {
    // A chunk whose response was lost in transit replays as zero, so the number
    // is "at least". Printing it as an exact total is the lie worth preventing.
    const notice = buildIngestSummary(REUPLOAD).coreRefusedNotice!;
    expect(notice).toContain('At least');
    expect(notice).toContain('1,204');
  });

  it('says what it is separate FROM, and claims no corrected total', () => {
    const notice = buildIngestSummary(REUPLOAD).coreRefusedNotice!;
    // An operator reading this next to "4,800 accepted" will reach for
    // subtraction, so the line has to name the two counts as unrelated…
    expect(notice).toContain('200 rejected');
    expect(notice).toContain('separate');
    expect(notice).toContain('overstates');
    // …and must not print `4800 - 1204`, which would present an upper bound as
    // a fact (the refusal count is a floor, so the difference is not the truth).
    expect(notice).not.toContain('3,596');
  });

  it('offers the sampled rows as examples from the start of the file', () => {
    // Master caps the sample at 20 in file order, so on a heavily-colliding
    // re-upload chunk 0 alone fills it. Presenting it as a spread across the
    // file would have an operator conclude the later rows were fine.
    const sample = buildIngestSummary(REUPLOAD).coreRefusedSample!;
    expect(sample).toContain('3, 8, 12, 19');
    expect(sample).toContain('start of the file');
    expect(sample).toContain('examples');
  });

  it('reports a count with no sample rather than suppressing the count', () => {
    const summary = buildIngestSummary(
      job({ rows_read: 10, accepted: 10, core_rejected_duplicate_rows: 4 }),
    );
    expect(summary.coreRefusedNotice).toContain('At least 4');
    expect(summary.coreRefusedSample).toBeNull();
  });

  it('is silent when core refused nothing', () => {
    const summary = buildIngestSummary(OPERATOR_FILE);
    expect(summary.coreRefused).toBe(0);
    expect(summary.coreRefusedNotice).toBeNull();
    expect(summary.coreRefusedSample).toBeNull();
  });

  it('renders nothing rather than NaN for a job written before master had the columns', () => {
    // Master defaults these itself, but a row from before its migration 055 has
    // no key at all — and `NaN duplicates` over a real import is worse than
    // silence.
    const legacy = job();
    delete (legacy as Partial<AgencyIngestJob>).core_rejected_duplicate_rows;
    delete (legacy as Partial<AgencyIngestJob>).core_duplicate_source_rows;

    const summary = buildIngestSummary(legacy);
    expect(summary.coreRefused).toBe(0);
    expect(summary.coreRefusedNotice).toBeNull();
  });

  it('is singular for one refused row', () => {
    const summary = buildIngestSummary(
      job({ rows_read: 2, accepted: 2, core_rejected_duplicate_rows: 1 }),
    );
    expect(summary.coreRefusedNotice).toContain('rows was');
    expect(summary.coreRefusedNotice).not.toContain('rows were');
  });
});

describe('terminal notices', () => {
  it('says how many rows a cancelled import actually loaded', () => {
    // §B.8: never a silent partial. An operator told only "cancelled" assumes
    // either all or none, and both are wrong.
    const notice = terminalNotice(job({ status: 'cancelled', rows_read: 12_481, accepted: 6_204 }));
    expect(notice).toContain('6,204');
    expect(notice).toContain('12,481');
  });

  it('surfaces the failure message when master gave one', () => {
    expect(
      terminalNotice(job({ status: 'failed', error_message: 'Could not read the CSV.' })),
    ).toBe('Could not read the CSV.');
  });

  it('is silent for a completed job', () => {
    expect(terminalNotice(job())).toBeNull();
  });

  it('treats exactly the three terminal statuses as terminal', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});
