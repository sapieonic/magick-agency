import { describe, it, expect } from 'vitest';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAtSql,
} from '../../../src/keyset-cursor.js';

const SAMPLE_ID = '3f2a1b0c-1111-4222-8333-444455556666';

const POSITION = { at: '2026-08-17T14:03:11.123456Z', id: SAMPLE_ID };

describe('keyset cursor', () => {
  it('round-trips a MICROSECOND timestamp without losing precision', () => {
    const decoded = decodeKeysetCursor(encodeKeysetCursor(POSITION));
    expect(decoded).toEqual(POSITION);
    // The load-bearing assertion: a `Date` would have flattened this to .123Z
    // and the comparison would then skip every row in (cursor, row].
    expect(decoded?.at).toBe('2026-08-17T14:03:11.123456Z');
    expect(new Date(decoded!.at).toISOString()).not.toBe(decoded!.at);
  });

  it('is base64url — safe in a query string with no escaping', () => {
    const encoded = encodeKeysetCursor(POSITION);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('rejects a non-UUID id — that value would reach Postgres as 22P02 and 500', () => {
    const forged = Buffer.from(JSON.stringify({ at: POSITION.at, id: "'; DROP TABLE" }), 'utf8')
      .toString('base64url');
    expect(decodeKeysetCursor(forged)).toBeNull();
  });

  it('rejects a malformed timestamp, garbage, and an empty string', () => {
    const badAt = Buffer.from(JSON.stringify({ at: 'yesterday', id: POSITION.id }), 'utf8')
      .toString('base64url');
    expect(decodeKeysetCursor(badAt)).toBeNull();
    expect(decodeKeysetCursor('not-base64-json')).toBeNull();
    expect(decodeKeysetCursor('')).toBeNull();
    expect(decodeKeysetCursor(Buffer.from('null').toString('base64url'))).toBeNull();
  });

  /**
   * The regex is a SHAPE check, and shape is not calendar. Each of these
   * matches `\d{4}-\d{2}-\d{2}T…` and would previously be handed to the
   * repository, where `::timestamptz` raises `22008 date/time field value out
   * of range` — a 500 carrying the database's error text for what is an
   * ordinary bad request. Verified against Postgres 16, not assumed.
   */
  it.each([
    ['2026-02-30T00:00:00.000000Z', 'a day the month does not have'],
    ['2026-04-31T00:00:00.000000Z', 'April 31st'],
    ['0000-08-17T14:03:11.123456Z', 'year zero — Postgres has no year 0'],
  ])('rejects %s (%s) rather than 500ing on the ::timestamptz cast', (at) => {
    const forged = Buffer.from(JSON.stringify({ at, id: SAMPLE_ID }), 'utf8').toString('base64url');
    expect(decodeKeysetCursor(forged)).toBeNull();
  });

  it('still accepts the real dates either side of those — the check is not over-tight', () => {
    for (const at of [
      '2026-02-28T00:00:00.000000Z',
      '2026-03-01T00:00:00.000000Z',
      '2024-02-29T00:00:00.000000Z', // a real leap day
      '0001-01-01T00:00:00.000000Z',
      '9999-12-31T23:59:59.999999Z',
    ]) {
      const cursor = encodeKeysetCursor({ at, id: SAMPLE_ID });
      expect(decodeKeysetCursor(cursor)).toEqual({ at, id: SAMPLE_ID });
    }
  });

  it('renders the column in UTC, so two replicas cannot mint disagreeing cursors', () => {
    const sql = keysetAtSql('a.created_at');
    expect(sql).toContain("a.created_at AT TIME ZONE 'UTC'");
    expect(sql).toContain('US');
  });
});
