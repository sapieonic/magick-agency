import { describe, expect, it } from 'vitest';
import { parseContactFilters, parseRetrySelector } from '../../../src/agency/spine-filters.js';
import {
  contactFilterConditions,
  params,
  retrySelectionConditions,
} from '../../../src/db/repositories/agency/query-builders.js';
import {
  CONTACT_CSV_COLUMNS,
  CONTACT_QUERY_PARAMS,
  contactCsvRow,
  enrichContactOwnerNames,
} from '../../../src/agency/agency-spine.js';

/**
 * The roster's `assigned_to` filter (contact assignment): parsed on the contacts list,
 * forwarded by the public layer, turned into SQL by the shared contact-filter builder, and
 * NEVER a retry-selector dimension (the console strips it as a non-selector filter; the
 * server refuses it if sent). The SQL itself is pinned on real Postgres in
 * `test/integration/api/agency-contact-assignment.test.ts`.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('assigned_to on the roster', () => {
  it('parses ids and unassigned, repeated or comma-separated', () => {
    const parsed = parseContactFilters({ assigned_to: [`${A.toUpperCase()},unassigned`, B] });
    expect(parsed).toEqual({ ok: true, filters: { assignedTo: { userIds: [A, B], unassigned: true } } });
  });

  it('refuses a value that is neither an id nor unassigned', () => {
    const parsed = parseContactFilters({ assigned_to: 'nobody' });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issues[0]!.param).toBe('assigned_to');
  });

  it('becomes an owner predicate: ids, the pool, or either', () => {
    const one = params();
    expect(contactFilterConditions({ assignedTo: { userIds: [A], unassigned: false } }, 'c', one))
      .toEqual(['c.assigned_user_id = ANY($1::uuid[])']);
    const pool = params();
    expect(contactFilterConditions({ assignedTo: { userIds: [], unassigned: true } }, 'c', pool))
      .toEqual(['c.assigned_user_id IS NULL']);
    const both = params();
    expect(contactFilterConditions({ assignedTo: { userIds: [A], unassigned: true } }, 'c', both))
      .toEqual(['(c.assigned_user_id = ANY($1::uuid[]) OR c.assigned_user_id IS NULL)']);
  });

  it('is forwarded by the public layer on the list and the CSV', () => {
    expect(CONTACT_QUERY_PARAMS).toContain('assigned_to');
  });

  it('is refused as a retry selector dimension, and the seed predicate never reads the owner', () => {
    const refused = parseRetrySelector({ state: ['exhausted'], assigned_to: [A] }, { catalog: [] });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.issues.map((i) => i.param)).toContain('assigned_to');
    const sql = retrySelectionConditions({ state: ['exhausted'] }, 'c', params()).join(' AND ');
    expect(sql).not.toContain('assigned_user_id');
  });
});

describe('the roster CSV owner columns', () => {
  it('appends the owner id, name and time', () => {
    expect(CONTACT_CSV_COLUMNS.slice(-3)).toEqual(['assigned_user_id', 'assigned_to', 'assigned_at']);
    const line = contactCsvRow({
      id: 'c1', phone_e164: '+1', state: 'pending', attempt_count: 0, our_fault_attempts: 0,
      last_outcome: null, last_disposition: null, next_attempt_at: 'n', suppressed_reason: null,
      timezone: null, csv_line_number: 1, created_at: 'c', updated_at: 'u',
      assigned_user_id: A, assigned_to_name: 'Asha', assigned_at: 't',
    });
    expect(line.trimEnd().endsWith(`${A},Asha,t`)).toBe(true);
  });

  it('names owners in one lookup per page and degrades to blanks', async () => {
    const body = { rows: [{ assigned_user_id: A }, { assigned_user_id: null }, { assigned_user_id: A }], next_cursor: null, limit: 3 };
    const calls: string[][] = [];
    const named = await enrichContactOwnerNames(body, 't', async (ids) => {
      calls.push([...ids]);
      return new Map([[A, 'Asha']]);
    }) as { rows: Array<{ assigned_to_name: string | null }> };
    expect(calls).toEqual([[A]]);
    expect(named.rows.map((r) => r.assigned_to_name)).toEqual(['Asha', null, 'Asha']);

    const failed = await enrichContactOwnerNames(body, 't', async () => { throw new Error('down'); }) as typeof named;
    expect(failed.rows.map((r) => r.assigned_to_name)).toEqual([null, null, null]);
  });
});
