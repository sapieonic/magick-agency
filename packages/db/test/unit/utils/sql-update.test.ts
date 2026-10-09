import { describe, it, expect } from 'vitest';
import { buildUpdateSet } from '../../../src/utils/sql-update.js';

const ALLOWED = new Set(['status', 'error_code', 'variables', 'ended_at']);
const JSON_COLS = new Set(['variables']);

describe('buildUpdateSet', () => {
  it('builds positional SET clauses for allowed columns in insertion order', () => {
    const { clauses, values } = buildUpdateSet(
      { status: 'completed', error_code: 'NONE' },
      ALLOWED,
    );
    expect(clauses).toEqual(['status = $1', 'error_code = $2']);
    expect(values).toEqual(['completed', 'NONE']);
  });

  it('skips undefined values (and does not consume a param index for them)', () => {
    const { clauses, values } = buildUpdateSet(
      { status: 'failed', error_code: undefined, ended_at: new Date(0) },
      ALLOWED,
    );
    expect(clauses).toEqual(['status = $1', 'ended_at = $2']);
    expect(values).toEqual(['failed', new Date(0)]);
  });

  it('JSON.stringify-es columns listed in jsonColumns', () => {
    const { clauses, values } = buildUpdateSet(
      { variables: { a: '1', b: '2' } },
      ALLOWED,
      JSON_COLS,
    );
    expect(clauses).toEqual(['variables = $1']);
    expect(values).toEqual(['{"a":"1","b":"2"}']);
  });

  it('does not stringify non-json columns', () => {
    const { values } = buildUpdateSet({ status: 'queued' }, ALLOWED, JSON_COLS);
    expect(values).toEqual(['queued']);
  });

  it('returns empty clauses/values when every field is undefined', () => {
    const { clauses, values } = buildUpdateSet(
      { status: undefined, error_code: undefined },
      ALLOWED,
    );
    expect(clauses).toEqual([]);
    expect(values).toEqual([]);
  });

  it('throws when a non-undefined value targets a column outside the allow-list', () => {
    expect(() =>
      buildUpdateSet({ status: 'ok', tenant_id: 'evil' } as Record<string, unknown>, ALLOWED),
    ).toThrow(/Disallowed update column: tenant_id/);
  });

  it('rejects an SQL-injection-shaped key before it can reach the query string', () => {
    expect(() =>
      buildUpdateSet(
        { 'status = \'x\'; DROP TABLE calls; --': 'boom' } as Record<string, unknown>,
        ALLOWED,
      ),
    ).toThrow(/Disallowed update column/);
  });

  it('ignores a disallowed key when its value is undefined (no false positive)', () => {
    const { clauses } = buildUpdateSet(
      { status: 'ok', not_a_column: undefined } as Record<string, unknown>,
      ALLOWED,
    );
    expect(clauses).toEqual(['status = $1']);
  });
});
