import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_EXPORT_PAGE_SIZE,
  ACTIVITY_MAX_LIMIT,
  ACTIVITY_CSV_COLUMNS,
  activityCsvHeader,
  activityCsvRow,
  buildActivityCsvPreamble,
  compareActivityRows,
  decodeActivityCursor,
  encodeActivityCursor,
  mergeActivityPage,
  normalizeCoreRow,
  normalizeMasterRow,
  type ActivityCsvPreambleInput,
  type ActivityCursor,
  type ActivityRow,
} from '../../../src/agency/agency-activity.js';
import type { AuditLogRecord } from '@magick-agency/db/models/platform/audit.model';

const EMPTY_CURSOR: ActivityCursor = { master: null, core: null };

function masterRecord(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: 'm1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    user_id: 'user-1',
    actor_type: 'human',
    action: 'agency_disposition.created',
    resource_type: 'agency_disposition',
    // The attempt id, NOT the campaign id — the trap here.
    resource_id: 'attempt-9',
    campaign_id: 'camp-1',
    details: { disposition_code: 'promise_to_pay', campaign_id: 'camp-1' },
    ip_address: '10.0.0.1',
    created_at: new Date('2026-08-01T12:00:00.000Z'),
    ...overrides,
  };
}

function coreRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    timestamp: '2026-08-01T11:00:00.000Z',
    event_type: 'agency_campaign.auto_paused',
    severity: 'error',
    actor: 'system:abandonment-guardrail',
    call_id: null,
    event_data: { campaign_id: 'camp-1', measured_pct: 4.2, ceiling_pct: 3 },
    ...overrides,
  };
}

/** A synthetic already-normalised row, for ordering and merge cases. */
function row(source: 'master' | 'core', id: string, at: string): ActivityRow {
  return {
    id: `${source}:${id}`,
    at,
    source,
    action: 'x',
    actor: { type: 'system', system: true, user_id: null, api_key_id: null, display: null },
    target: { type: null, id: null },
    detail: {},
  };
}

describe('normalizeMasterRow', () => {
  it('resolves the acting user to a display name', () => {
    const normalized = normalizeMasterRow(masterRecord(), new Map([['user-1', 'Sam Patel']]));

    expect(normalized).toMatchObject({
      id: 'master:m1',
      at: '2026-08-01T12:00:00.000Z',
      source: 'master',
      action: 'agency_disposition.created',
      actor: { type: 'human', system: false, user_id: 'user-1', api_key_id: null, display: 'Sam Patel' },
      target: { type: 'agency_disposition', id: 'attempt-9' },
      detail: { disposition_code: 'promise_to_pay', campaign_id: 'camp-1' },
    });
  });

  /**
   * A deleted user's actions are still part of the trail. Dropping the row —
   * or the id — would be the one omission an audit cannot afford.
   */
  it('keeps the user id when the name cannot be resolved', () => {
    const normalized = normalizeMasterRow(masterRecord(), new Map());

    expect(normalized.actor).toEqual({
      type: 'human', system: false, user_id: 'user-1', api_key_id: null, display: null,
    });
  });

  /**
   * A `system` row is a background write (the scheduler), not a human who could
   * not be identified — attributing it to nobody rather than to the machine
   * would misreport who acted.
   */
  it('reports a system row as a system action', () => {
    const normalized = normalizeMasterRow(masterRecord({ actor_type: 'system', user_id: null }), new Map());

    expect(normalized.actor).toEqual({
      type: 'system', system: true, user_id: null, api_key_id: null, display: 'system',
    });
  });

  /**
   * ── Rows written before migration 067 must render exactly as they did ──────
   *
   * `actor_type IS NULL` is "not recorded", and there is nothing to read. Those
   * rows fall back to the inference this function made before the column
   * existed, so a historical trail does not visibly change under a deploy — a
   * display shift on old rows reads as the audit being rewritten. `type` still
   * reports `'unknown'`, so a client can tell that the distinction was never
   * captured rather than being told a value the console would be guessing at.
   */
  describe('rows that predate the actor_type column', () => {
    it('renders a legacy row with a user as it always did', () => {
      const normalized = normalizeMasterRow(
        masterRecord({ actor_type: null }),
        new Map([['user-1', 'Sam Patel']]),
      );

      expect(normalized.actor).toEqual({
        type: 'unknown', system: false, user_id: 'user-1', api_key_id: null, display: 'Sam Patel',
      });
    });

    it('renders a legacy row with no user as it always did', () => {
      const normalized = normalizeMasterRow(masterRecord({ actor_type: null, user_id: null }), new Map());

      expect(normalized.actor).toEqual({
        type: 'unknown', system: true, user_id: null, api_key_id: null, display: 'system',
      });
    });
  });
});

describe('normalizeCoreRow', () => {
  it('derives the campaign target from event_data and keeps the measured rate', () => {
    const normalized = normalizeCoreRow(coreRecord());

    expect(normalized).toMatchObject({
      id: 'core:c1',
      source: 'core',
      action: 'agency_campaign.auto_paused',
      actor: {
        type: 'system', system: true, user_id: null, api_key_id: null,
        display: 'system:abandonment-guardrail',
      },
      target: { type: 'agency_campaign', id: 'camp-1' },
      detail: { measured_pct: 4.2, ceiling_pct: 3, severity: 'error' },
    });
  });

  it('falls back to the call as the target, and to nothing rather than a guess', () => {
    expect(normalizeCoreRow(coreRecord({ event_data: {}, call_id: 'call-7' })).target)
      .toEqual({ type: 'call', id: 'call-7' });
    expect(normalizeCoreRow(coreRecord({ event_data: {}, call_id: null })).target)
      .toEqual({ type: null, id: null });
  });

  /**
   * The dialer side has no user table (design D3), so a non-`system:` actor is an
   * originator string, not an id. Reporting it as `user_id` would invite the
   * client to link it to a person who does not exist on that side.
   */
  it('never claims a user id for a dialer-side row', () => {
    const normalized = normalizeCoreRow(coreRecord({ actor: 'console@example.com' }));

    expect(normalized.actor).toEqual({
      // `unknown`, NOT `human`: the dialer side has no notion of platform API
      // keys, so its originator string cannot say whether a person was behind
      // the call. Claiming `human` would manufacture exactly the fact `actor_type` was
      // added to record, because nobody had recorded it.
      type: 'unknown',
      system: false,
      user_id: null,
      api_key_id: null,
      display: 'console@example.com',
    });
  });

  /**
   * The `system:` PREFIX is what proves a dialer-side write was automatic — never the
   * absence of an actor.
   *
   * The dialer side recording nothing (and `parseCoreBody` normalising a non-string to
   * null) is "I could not work out who", which is not "no caller existed".
   * Reporting `type: 'system'` there manufactures the strongest claim on the
   * enum out of missing data — the same ambiguity as the dialer's own
   * `last_transition_by`, since `system` and `unattributed` are opposite
   * conclusions for an incident.
   */
  it('reports a null dialer-side actor as unknown, not as system', () => {
    expect(normalizeCoreRow(coreRecord({ actor: null })).actor.type).toBe('unknown');
    expect(normalizeCoreRow(coreRecord({ actor: 'system:abandonment-guardrail' })).actor.type)
      .toBe('system');
  });

  /**
   * …and the RENDERING flag keeps the old reading, so `type` and `system`
   * deliberately disagree on exactly this row.
   *
   * Same split `normalizeMasterRow` makes for a NULL `actor_type`: the page
   * renders from `system`, and flipping historical dialer-side rows out of "System"
   * reads as the audit being rewritten. Pinned because the two fields looking
   * inconsistent is precisely what invites someone to "fix" one of them.
   */
  it('keeps the legacy system flag on a null dialer-side actor', () => {
    const actor = normalizeCoreRow(coreRecord({ actor: null })).actor;

    expect(actor.system).toBe(true);
    expect(actor.type).toBe('unknown');
  });
});

describe('compareActivityRows', () => {
  it('is newest first', () => {
    const rows = [
      row('master', 'a', '2026-08-01T10:00:00.000Z'),
      row('master', 'b', '2026-08-01T12:00:00.000Z'),
    ].sort(compareActivityRows);

    expect(rows.map((r) => r.at)).toEqual(['2026-08-01T12:00:00.000Z', '2026-08-01T10:00:00.000Z']);
  });

  /**
   * Ties are the common case, not the rare one: both audit loggers batch, one
   * flush is one transaction, and `now()` is fixed per transaction — so a whole
   * flush shares a timestamp to the microsecond. Without a total order there is
   * no well-defined "page 2".
   */
  it('breaks a tie deterministically, whatever order the inputs arrive in', () => {
    const at = '2026-08-01T12:00:00.000Z';
    const rows = [row('master', 'a', at), row('core', 'b', at), row('master', 'z', at)];

    const forward = [...rows].sort(compareActivityRows).map((r) => r.id);
    const reversed = [...rows].reverse().sort(compareActivityRows).map((r) => r.id);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual(['core:b', 'master:z', 'master:a']);
  });
});

describe('mergeActivityPage', () => {
  it('interleaves both sources into one time-ordered page', () => {
    const merged = mergeActivityPage({
      masterRows: [
        row('master', 'm1', '2026-08-01T12:00:00.000Z'),
        row('master', 'm2', '2026-08-01T09:00:00.000Z'),
      ],
      coreRows: [
        row('core', 'c1', '2026-08-01T11:00:00.000Z'),
        row('core', 'c2', '2026-08-01T10:00:00.000Z'),
      ],
      limit: 10,
      cursor: EMPTY_CURSOR,
    });

    expect(merged.rows.map((r) => r.id)).toEqual(['master:m1', 'core:c1', 'core:c2', 'master:m2']);
    expect(merged.nextCursor).toBeNull();
  });

  it('reports the stream exhausted only when neither side had a spare row', () => {
    const merged = mergeActivityPage({
      masterRows: [row('master', 'm1', '2026-08-01T12:00:00.000Z')],
      coreRows: [row('core', 'c1', '2026-08-01T11:00:00.000Z')],
      limit: 1,
      cursor: EMPTY_CURSOR,
    });

    expect(merged.rows.map((r) => r.id)).toEqual(['master:m1']);
    // The dialer-side row did not fit, so it is the next page — and the cursor must
    // carry the console's position forward without touching the dialer's.
    expect(merged.nextCursor).toEqual({
      master: { at: '2026-08-01T12:00:00.000Z', id: 'm1' },
      core: null,
    });
  });

  /**
   * A source that contributed nothing may simply have no rows left in this
   * window. Resetting its cursor would restart it from the top on the next page,
   * which reads as duplicates to whoever is scrolling.
   */
  it('carries a silent source\'s position forward unchanged', () => {
    const cursor: ActivityCursor = {
      master: null,
      core: { at: '2026-08-01T08:00:00.000Z', id: 'c9' },
    };

    const merged = mergeActivityPage({
      masterRows: [
        row('master', 'm1', '2026-08-01T12:00:00.000Z'),
        row('master', 'm2', '2026-08-01T11:00:00.000Z'),
      ],
      coreRows: [],
      limit: 1,
      cursor,
    });

    expect(merged.nextCursor).toEqual({
      master: { at: '2026-08-01T12:00:00.000Z', id: 'm1' },
      core: { at: '2026-08-01T08:00:00.000Z', id: 'c9' },
    });
  });

  it('strips the source prefix from the cursor, since the store never saw it', () => {
    const merged = mergeActivityPage({
      masterRows: [row('master', 'm1', '2026-08-01T12:00:00.000Z')],
      coreRows: [
        row('core', 'c1', '2026-08-01T11:00:00.000Z'),
        row('core', 'c2', '2026-08-01T10:00:00.000Z'),
      ],
      limit: 2,
      cursor: EMPTY_CURSOR,
    });

    expect(merged.nextCursor?.core).toEqual({ at: '2026-08-01T11:00:00.000Z', id: 'c1' });
    expect(merged.nextCursor?.master).toEqual({ at: '2026-08-01T12:00:00.000Z', id: 'm1' });
  });
});

/**
 * The whole-stream property, driven against a
 * fixed corpus: every row exactly once, in one non-increasing time order.
 * This is the case a naive merge of two offset-paginated sources fails.
 */
describe('paging the merged stream', () => {
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 7, 1, 12, 0, 0) - minutes * 60_000).toISOString();

  // Deliberately dense in ties: three console rows and two dialer rows all share
  // one timestamp, which is what a single audit flush actually looks like.
  const masterCorpus = [
    row('master', 'm1', at(0)),
    row('master', 'm2', at(0)),
    row('master', 'm3', at(0)),
    row('master', 'm4', at(5)),
    row('master', 'm5', at(9)),
  ];
  const coreCorpus = [
    row('core', 'c1', at(0)),
    row('core', 'c2', at(0)),
    row('core', 'c3', at(3)),
    row('core', 'c4', at(7)),
  ];

  /** The repositories' contract: `(at, id)` descending, strictly after `before`. */
  function fetch(corpus: ActivityRow[], before: { at: string; id: string } | null, take: number) {
    return corpus
      .slice()
      .sort(compareActivityRows)
      .filter((r) => {
        if (!before) return true;
        const rawId = r.id.slice(r.source.length + 1);
        if (r.at !== before.at) return r.at < before.at;
        return rawId < before.id;
      })
      .slice(0, take);
  }

  it.each([1, 2, 3, 4, 20])('serves every row exactly once at page size %i', (limit) => {
    let cursor: ActivityCursor | null = EMPTY_CURSOR;
    const seen: ActivityRow[] = [];

    // Bounded so a non-converging cursor fails as a wrong count rather than
    // hanging the suite.
    for (let page = 0; cursor !== null && page < 50; page += 1) {
      const merged: ReturnType<typeof mergeActivityPage> = mergeActivityPage({
        masterRows: fetch(masterCorpus, cursor.master, limit + 1),
        coreRows: fetch(coreCorpus, cursor.core, limit + 1),
        limit,
        cursor,
      });
      seen.push(...merged.rows);
      cursor = merged.nextCursor;
    }

    const expected = [...masterCorpus, ...coreCorpus].sort(compareActivityRows).map((r) => r.id);
    expect(seen.map((r) => r.id)).toEqual(expected);
    expect(new Set(seen.map((r) => r.id)).size).toBe(expected.length);
  });

  /**
   * A row written mid-pagination is NEWER than the cursor and therefore outside
   * every remaining window — the property an OFFSET does not have, and the
   * reason both repositories take a keyset.
   */
  it('is not disturbed by a row written after the first page', () => {
    const master = [...masterCorpus];
    // Page size 3, so the console stream has actually emitted a row and therefore HAS a
    // position. (At size 2 the first page is dialer-only, the console cursor is still
    // null, and a row written at the very top legitimately appears next — it is
    // in front of a stream that has not started being read.)
    const first = mergeActivityPage({
      masterRows: fetch(master, null, 4),
      coreRows: fetch(coreCorpus, null, 4),
      limit: 3,
      cursor: EMPTY_CURSOR,
    });
    expect(first.nextCursor?.master).not.toBeNull();

    master.unshift(row('master', 'm0', new Date(Date.UTC(2026, 7, 1, 13)).toISOString()));

    const second = mergeActivityPage({
      masterRows: fetch(master, first.nextCursor!.master, 4),
      coreRows: fetch(coreCorpus, first.nextCursor!.core, 4),
      limit: 3,
      cursor: first.nextCursor!,
    });

    expect(second.rows.map((r) => r.id)).not.toContain('master:m0');
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the cursor codec', () => {
  it('round-trips a position', () => {
    const cursor: ActivityCursor = {
      master: { at: '2026-08-01T12:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' },
      core: null,
    };

    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  /**
   * Both audit tables key on `UUID` and the id goes straight into a keyset
   * predicate, so a non-uuid reaches Postgres as `22P02` — uncaught, which turns
   * a route whose contract is "never a 500" into exactly that, with the body
   * replaced by a support-ticket message.
   */
  it('refuses an id that is not a uuid, so it never reaches Postgres', () => {
    const raw = Buffer.from(
      JSON.stringify({ v: 1, master: { at: '2026-08-01T12:00:00.000Z', id: "not-a-uuid'; --" }, core: null }),
      'utf8',
    ).toString('base64url');

    expect(decodeActivityCursor(raw)).toBeNull();
  });

  it.each([
    ['not base64', '!!!!'],
    ['not json', Buffer.from('nope', 'utf8').toString('base64url')],
    ['a future version', Buffer.from(JSON.stringify({ v: 2 }), 'utf8').toString('base64url')],
    [
      'a position missing its id',
      Buffer.from(JSON.stringify({ v: 1, master: { at: '2026-08-01T12:00:00.000Z' }, core: null }), 'utf8')
        .toString('base64url'),
    ],
    [
      'an unparseable timestamp',
      Buffer.from(JSON.stringify({ v: 1, master: { at: 'yesterday', id: 'm1' }, core: null }), 'utf8')
        .toString('base64url'),
    ],
  ])('refuses %s', (_name, raw) => {
    expect(decodeActivityCursor(raw)).toBeNull();
  });
});

describe('the CSV export', () => {
  it('has a stable header whatever the rows contain', () => {
    expect(activityCsvHeader()).toBe(
      'at,source,action,actor,actor_user_id,target_type,target_id,detail,'
      + 'actor_type,actor_api_key_id\n',
    );
  });

  it('quotes a detail blob containing commas and quotes', () => {
    const line = activityCsvRow({
      ...row('core', 'c1', '2026-08-01T11:00:00.000Z'),
      action: 'agency_campaign.auto_paused',
      actor: {
        type: 'system', system: true, user_id: null, api_key_id: null,
        display: 'system:abandonment-guardrail',
      },
      target: { type: 'agency_campaign', id: 'camp-1' },
      detail: { reason: 'abandonment_ceiling', measured_pct: 4.2 },
    });

    expect(line).toBe(
      '2026-08-01T11:00:00.000Z,core,agency_campaign.auto_paused,system:abandonment-guardrail,,'
      + 'agency_campaign,camp-1,"{""reason"":""abandonment_ceiling"",""measured_pct"":4.2}",system,\n',
    );
  });

  /**
   * The comma-split hole the preamble had to close by hand does NOT exist on a
   * data row, and this pins why rather than leaving it assumed: a field holding
   * a comma is QUOTED, so a parser reads the whole thing back as one cell and
   * there is no second, unguarded cell for a sigil to land in.
   *
   * Both halves are asserted — the quoting, and that the reassembled cell is not
   * a formula — because either alone would still pass against a broken escaper.
   */
  it('leaves a data field no comma-split cell to smuggle a formula into', () => {
    const line = activityCsvRow({
      ...row('master', 'm1', '2026-08-01T12:00:00.000Z'),
      actor: { type: 'human', system: false, user_id: 'u-1', api_key_id: null, display: 'Q3, =SUM(A1:A9)' },
    });

    const actorField = line.split(',').slice(3).join(',');
    // Quoted, so the comma never becomes a cell boundary.
    expect(actorField.startsWith('"Q3, =SUM(A1:A9)"')).toBe(true);
    // And the one cell it does produce is text, not a formula.
    expect(actorField.replace(/^"/, '').replace(/^ +/, '')).not.toMatch(/^[=+\-@\t]/);
  });

  /**
   * ── The eight original columns keep their positions ────────────────────────
   *
   * The compliance export is read by saved spreadsheet templates and downstream
   * parsers that map by INDEX. Inserting `actor_type` beside `actor` — which
   * reads better — would have shifted `target_type`, `target_id` and `detail`
   * right by one, so such a consumer silently reads `target_type` where it
   * expects `detail`, with no error anywhere. The two new columns are appended
   * for that reason; this pins it, because the ordering is otherwise the kind of
   * thing a later reader tidies up.
   */
  it('leaves the eight pre-existing columns at their original indices', () => {
    expect([...ACTIVITY_CSV_COLUMNS].slice(0, 8)).toEqual([
      'at', 'source', 'action', 'actor', 'actor_user_id', 'target_type', 'target_id', 'detail',
    ]);
  });

  /**
   * A leading space does not protect a sigil: spreadsheets classify the cell
   * after trimming it. The apostrophe still goes at position zero, which is
   * where the text marker has to be to be read as one.
   */
  it('guards a field whose sigil hides behind a leading space', () => {
    const line = activityCsvRow({
      ...row('master', 'm1', '2026-08-01T12:00:00.000Z'),
      actor: { type: 'human', system: false, user_id: 'u-1', api_key_id: null, display: ' =SUM(A1:A9)' },
    });

    expect(line.split(',')[3]).toBe("' =SUM(A1:A9)");
  });
});

describe('the CSV preamble', () => {
  function preambleInput(overrides: Partial<ActivityCsvPreambleInput> = {}): ActivityCsvPreambleInput {
    return {
      generatedAt: new Date('2026-08-18T09:00:00.000Z'),
      campaignId: 'camp-1',
      campaignName: 'Q3 collections',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      actions: null,
      from: null,
      to: null,
      rowCount: 0,
      truncated: null,
      rowLimit: 5000,
      retention: null,
      ...overrides,
    };
  }

  it('states every filter that was applied', () => {
    const lines = buildActivityCsvPreamble(preambleInput({
      actions: ['agency_campaign.paused', 'dnc_entry.created'],
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    })).join('');

    expect(lines).toContain('Filter — action: agency_campaign.paused | dnc_entry.created');
    expect(lines).toContain('Filter — from: 2026-08-01T00:00:00.000Z');
    expect(lines).toContain('Filter — to: 2026-08-31T00:00:00.000Z');
  });

  /**
   * A reviewer must be able to tell "there were no DNC marks" from "DNC marks
   * were filtered out" — a missing line would read as the first no matter
   * which is true, so the absence of a filter has to be its own sentence.
   */
  it('says explicitly when a filter was not applied, for each of the three independently', () => {
    const lines = buildActivityCsvPreamble(preambleInput()).join('');

    expect(lines).toContain('Filter — action: none applied — every action type is included');
    expect(lines).toContain('Filter — from: none applied — no lower bound');
    expect(lines).toContain('Filter — to: none applied — no upper bound');
  });

  it('reports the row count and that the export was not truncated', () => {
    const lines = buildActivityCsvPreamble(preambleInput({ rowCount: 42, truncated: null })).join('');

    expect(lines).toContain('Rows exported: 42');
    expect(lines).toContain('Truncated: no — this is the complete trail for the filters above');
  });

  /**
   * The preamble must never contradict the `X-Activity-Truncated*` headers the
   * route sets from the same variables — this pins that both truncation
   * reasons are actually distinguishable in the text a reviewer reads.
   */
  it.each([
    ['row_limit' as const, 'export ceiling'],
    ['time_limit' as const, "time budget"],
  ])('names %s truncation in its own words', (reason, expectedText) => {
    const lines = buildActivityCsvPreamble(preambleInput({ rowCount: 5000, truncated: reason })).join('');

    expect(lines).toContain('Truncated: yes');
    expect(lines).toContain(expectedText);
  });

  it.each([
    ['partition_bound' as const, '2026-05-01T00:00:00.000Z', 'records retained from 2026-05-01T00:00:00.000Z onward (source: partition_bound)'],
    ['unbounded' as const, null, 'unbounded — the dialer reports no retention horizon for this campaign'],
    ['unknown' as const, null, 'unknown (source: unknown)'],
  ])('renders the %s retention source', (source, earliestRetainedAt, expectedText) => {
    const lines = buildActivityCsvPreamble(preambleInput({
      retention: { earliest_retained_at: earliestRetainedAt, source },
    })).join('');

    expect(lines).toContain(expectedText);
  });

  /**
   * Absent or unreadable retention is reported, not omitted — silence reads as
   * "no limit", which is the one thing this line must never be mistaken for.
   */
  it('says retention is unknown rather than omitting the line when the dialer side carried none', () => {
    const lines = buildActivityCsvPreamble(preambleInput({ retention: null })).join('');

    expect(lines).toContain('Retention: unknown — the dialer\'s retention horizon could not be determined');
  });

  it('explains the source column legend', () => {
    const lines = buildActivityCsvPreamble(preambleInput()).join('');

    expect(lines).toContain("'master' rows are recorded by the console");
    expect(lines).toContain("'core' rows are recorded by the dialer");
  });

  it('names its own RFC 4180 tradeoff and how to opt out', () => {
    const lines = buildActivityCsvPreamble(preambleInput()).join('');

    expect(lines).toContain('not an RFC 4180 data row');
    expect(lines).toContain('preamble=false');
  });

  it('prefixes every line with the comment marker', () => {
    const lines = buildActivityCsvPreamble(preambleInput());

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('# ')).toBe(true);
      expect(line.endsWith('\n')).toBe(true);
    }
  });

  /**
   * The trap this whole helper exists to close. A campaign name, an id, or a
   * filter value carrying a raw newline must not be able to end the current
   * `#` line early and start an un-prefixed line of its own choosing — that
   * would forge an extra preamble line, or with two newlines, a fabricated
   * data row ahead of the real header.
   */
  it('strips CR/LF from a hostile campaign name rather than letting it forge a line', () => {
    const hostile = 'Q3\n# Rows exported: 0\r\ninjected,line,here';
    const lines = buildActivityCsvPreamble(preambleInput({ campaignName: hostile }));

    expect(lines).toHaveLength(13);
    for (const line of lines) {
      expect(line).not.toContain('\r');
      // Only the trailing newline each line intentionally ends with — never
      // one embedded mid-line from an interpolated value.
      expect(line.indexOf('\n')).toBe(line.length - 1);
    }
    expect(lines.join('')).toContain('Q3 # Rows exported: 0 injected,line,here');
  });

  it('strips CR/LF from a hostile filter value the same way', () => {
    const lines = buildActivityCsvPreamble(preambleInput({
      actions: ['agency_campaign.paused\ninjected'],
    }));

    for (const line of lines) {
      expect(line.indexOf('\n')).toBe(line.length - 1);
    }
  });

  it('guards a campaign name that starts with a formula sigil', () => {
    const lines = buildActivityCsvPreamble(preambleInput({ campaignName: '=SUM(A1:A9)' })).join('');

    expect(lines).toContain("Campaign: '=SUM(A1:A9)");
  });

  /**
   * A preamble line is not RFC-4180 quoted, so a value containing a comma splits
   * into further, independently-classified cells when a spreadsheet parses the
   * row — and a guard tested against the START of the whole value misses every
   * one of them. `Q3, =SUM(A1:A9)` begins with `Q`, so nothing was prefixed, the
   * line went out as `# Campaign: Q3, =SUM(A1:A9)`, and the second cell held a
   * live formula.
   *
   * Both spellings are pinned. The spaced one is what a human types and is the
   * one the guard would still miss if it only looked at character zero of each
   * field: spreadsheets classify a cell after trimming leading spaces.
   */
  it.each([
    ['no space after the comma', 'Q3,=SUM(A1:A9)'],
    ['a space after the comma', 'Q3, =SUM(A1:A9)'],
    ['several sigils across several fields', 'Q3,=SUM(A1),+A2,-A3, @A4'],
  ])('leaves no live formula in any comma-split cell — %s', (_name, campaignName) => {
    const campaignLine = buildActivityCsvPreamble(preambleInput({ campaignName }))
      .find((line) => line.startsWith('# Campaign:'))!;

    // Split the way a spreadsheet splits an unquoted row, and classify each cell
    // the way it classifies one: leading spaces do not protect anything.
    for (const cell of campaignLine.split(',')) {
      expect(cell.replace(/^ +/, '')).not.toMatch(/^[=+\-@\t]/);
    }
    // The comma survives. Forbidding commas in campaign names would answer a
    // chain-of-custody question with a different name than the one on screen.
    expect(campaignLine).toContain('Q3,');
  });

  it('falls back to a placeholder when the campaign name is unavailable', () => {
    const lines = buildActivityCsvPreamble(preambleInput({ campaignName: null })).join('');

    expect(lines).toContain('Campaign: (name unavailable) (id: camp-1)');
  });
});

/**
 * ── Every page size here is bounded by the audit-logs request ceiling ────────
 * The merge asks each source for `limit + 1`, and the internal `/internal/audit-logs`
 * handler refuses a limit above its own ceiling — so a page size that leaves no room
 * for the extra row 400s on every full-size page and degrades the dialer half to
 * `partial`, a failure that looks exactly like it being down. On the CSV route that
 * `partial` is a 424 refusal of the entire export.
 *
 * The number is written out here as a mirror of `AUDIT_FIND_MAX_LIMIT` (the ceiling
 * the route reads from the audit repository), and a mirror is only useful if it
 * fails loudly: raising a page size past it must break this test rather than
 * production.
 */
const CORE_AUDIT_LOGS_MAX_LIMIT = 1000;

describe('the page ceiling', () => {
  it('leaves room for the merge\'s extra row inside the audit-logs cap', () => {
    expect(ACTIVITY_MAX_LIMIT + 1).toBeLessThanOrEqual(CORE_AUDIT_LOGS_MAX_LIMIT);
  });

  /**
   * The export page size is the one that actually approaches the cap — 99 never
   * did. This is the assertion that stops the next "just make the export pages
   * bigger" from silently turning every export into a 424.
   */
  it('keeps the export page inside that cap too, extra row included', () => {
    expect(ACTIVITY_EXPORT_PAGE_SIZE + 1).toBeLessThanOrEqual(CORE_AUDIT_LOGS_MAX_LIMIT);
  });

  /**
   * And the export page must genuinely be bigger than the interactive one, or
   * the constant is dead weight and the ~51 sequential round trips it exists to
   * collapse are still being made.
   */
  it('pages the export more coarsely than the screen', () => {
    expect(ACTIVITY_EXPORT_PAGE_SIZE).toBeGreaterThan(ACTIVITY_MAX_LIMIT);
  });
});
