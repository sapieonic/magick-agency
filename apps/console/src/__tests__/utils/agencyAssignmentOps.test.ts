import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  EMPTY_SELECTION,
  buildOperation,
  emptyDraft,
  operationAgentCount,
  rosterLinkFor,
  selectedInOrder,
  splitValues,
  stalePreviewOf,
  togglePage,
  toggleRow,
  withPreviewSeed,
} from '../../utils/agencyAssignmentOps';
import { rosterFiltersFromParams } from '../../utils/agencyRosterFilters';
import type { AgencyAssignmentPreview } from '@magick-agency/contracts/api/agency/assignment';

const PREVIEW: AgencyAssignmentPreview = {
  kind: 'random_split',
  preview_token: 'tok-1',
  seed: 'seed-1',
  matched: 10,
  moving: 8,
  skipped_live: 1,
  unchanged: 1,
  to_pool: 0,
  per_agent: [],
  same_number_groups: 2,
};

describe('buildOperation', () => {
  it('builds a random split with the pool-only default and number grouping on', () => {
    const built = buildOperation(emptyDraft('random_split', { agentIds: ['a', 'b'] }), []);
    expect(built).toEqual({
      ok: true,
      operation: {
        kind: 'random_split',
        agent_user_ids: ['a', 'b'],
        only_unassigned: true,
        group_same_number: true,
      },
    });
  });

  it('says what is missing instead of building an incomplete operation', () => {
    expect(buildOperation(emptyDraft('random_split'), [])).toEqual({ ok: false, reason: 'Pick at least one agent.' });
    expect(buildOperation(emptyDraft('count', { agentId: 'a', count: '0' }), []).ok).toBe(false);
    expect(buildOperation(emptyDraft('count', { agentId: 'a', count: '2.5' }), []).ok).toBe(false);
    expect(buildOperation(emptyDraft('rebalance', { agentIds: ['a'] }), []).ok).toBe(false);
    expect(buildOperation(emptyDraft('reassign', { fromId: 'a', agentId: 'a' }), []))
      .toEqual({ ok: false, reason: 'Pick two different agents.' });
    expect(buildOperation(emptyDraft('filter', { agentIds: ['a'] }), []).ok).toBe(false);
  });

  it('builds next N with the typed count', () => {
    expect(buildOperation(emptyDraft('count', { agentId: 'a', count: ' 25 ' }), [])).toEqual({
      ok: true,
      operation: { kind: 'count', agent_user_id: 'a', count: 25, group_same_number: true },
    });
  });

  it('builds a filter from states, last outcomes and a column, and refuses a half-filled column', () => {
    const draft = emptyDraft('filter', {
      agentIds: ['a', 'b'],
      filterStates: ['pending'],
      filterDispositions: ['callback'],
      columnName: ' Region ',
      columnValues: 'North,  East\nNorth',
      onlyUnassigned: false,
      groupSameNumber: false,
    });
    expect(buildOperation(draft, [])).toEqual({
      ok: true,
      operation: {
        kind: 'filter',
        agent_user_ids: ['a', 'b'],
        filter: {
          states: ['pending'],
          last_dispositions: ['callback'],
          column: { name: 'Region', values: ['North', 'East'] },
        },
        only_unassigned: false,
        group_same_number: false,
      },
    });
    expect(buildOperation({ ...draft, columnValues: '' }, []).ok).toBe(false);
    expect(buildOperation({ ...draft, columnName: '' }, []).ok).toBe(false);
  });

  it('holds a count to the server’s 1 to 10,00,000, and says so', () => {
    expect(buildOperation(emptyDraft('count', { agentId: 'a', count: '1000000' }), []).ok).toBe(true);
    expect(buildOperation(emptyDraft('count', { agentId: 'a', count: '1000001' }), [])).toEqual({
      ok: false, reason: 'Enter how many contacts, a whole number from 1 to 10,00,000.',
    });
    expect(buildOperation(emptyDraft('reassign', { fromId: 'a', agentId: 'b', count: '1000001' }), [])).toEqual({
      ok: false, reason: 'Enter a whole number from 1 to 10,00,000, or leave it blank for all.',
    });
    expect(buildOperation(emptyDraft('unassign', { fromId: 'a', count: '9007199254740991' }), []).ok).toBe(false);
  });

  it('holds a column filter to the server’s bounds: name ≤ 200, ≤ 100 values, each ≤ 500 characters', () => {
    const base = emptyDraft('filter', { agentIds: ['a'], columnName: 'Region' });
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`).join(',');
    expect(buildOperation({ ...base, columnValues: values(100) }, []).ok).toBe(true);
    expect(buildOperation({ ...base, columnValues: values(101) }, [])).toEqual({
      ok: false, reason: 'Enter at most 100 values at a time (you have 101).',
    });
    expect(buildOperation({ ...base, columnValues: 'x'.repeat(500) }, []).ok).toBe(true);
    expect(buildOperation({ ...base, columnValues: 'x'.repeat(501) }, [])).toEqual({
      ok: false, reason: 'Each value is at most 500 characters.',
    });
    expect(buildOperation({ ...base, columnName: 'n'.repeat(201), columnValues: 'North' }, [])).toEqual({
      ok: false, reason: 'A column name is at most 200 characters.',
    });
  });

  it('sends the ticked rows for a range, capped at the contract maximum', () => {
    expect(buildOperation(emptyDraft('range', { agentId: 'a' }), ['c1', 'c2'])).toEqual({
      ok: true,
      operation: { kind: 'range', agent_user_id: 'a', contact_ids: ['c1', 'c2'], group_same_number: true },
    });
    expect(buildOperation(emptyDraft('range', { agentId: 'a' }), []).ok).toBe(false);
    const tooMany = Array.from({ length: 501 }, (_, i) => `c${i}`);
    expect(buildOperation(emptyDraft('range', { agentId: 'a' }), tooMany).ok).toBe(false);
  });

  it('reassigns all, or the first N', () => {
    expect(buildOperation(emptyDraft('reassign', { fromId: 'a', agentId: 'b' }), [])).toEqual({
      ok: true,
      operation: { kind: 'reassign', from_user_id: 'a', to_user_id: 'b', group_same_number: true },
    });
    expect(buildOperation(emptyDraft('reassign', { fromId: 'a', agentId: 'b', count: '5' }), [])).toMatchObject({
      ok: true,
      operation: { count: 5 },
    });
    expect(buildOperation(emptyDraft('reassign', { fromId: 'a', agentId: 'b', count: 'x' }), []).ok).toBe(false);
  });

  it('unassigns one agent’s contacts or exactly the selected rows (never both)', () => {
    expect(buildOperation(emptyDraft('unassign', { fromId: 'a' }), ['c1'])).toEqual({
      ok: true,
      operation: { kind: 'unassign', from_user_id: 'a', group_same_number: true },
    });
    const bySelection = buildOperation(emptyDraft('unassign', { unassignSource: 'selected' }), ['c1']);
    expect(bySelection).toEqual({
      ok: true,
      operation: { kind: 'unassign', contact_ids: ['c1'], group_same_number: true },
    });
    expect(buildOperation(emptyDraft('unassign', { unassignSource: 'selected' }), []).ok).toBe(false);
  });
});

describe('withPreviewSeed', () => {
  it('commits a random split with the seed its preview used', () => {
    const built = buildOperation(emptyDraft('random_split', { agentIds: ['a'] }), []);
    if (!built.ok) throw new Error('expected an operation');
    expect(withPreviewSeed(built.operation, PREVIEW)).toMatchObject({ seed: 'seed-1' });
  });

  it('leaves an operation without a random order alone', () => {
    const built = buildOperation(emptyDraft('count', { agentId: 'a', count: '1' }), []);
    if (!built.ok) throw new Error('expected an operation');
    expect(withPreviewSeed(built.operation, PREVIEW)).not.toHaveProperty('seed');
  });
});

describe('stalePreviewOf', () => {
  it('reads the fresh preview off a 409 preview_stale body', () => {
    const err = new ApiError(409, { error: 'Conflict', code: 'preview_stale', message: 'stale', preview: PREVIEW });
    expect(stalePreviewOf(err)).toEqual(PREVIEW);
  });

  it('is null for any other refusal, or a stale body without a usable preview', () => {
    expect(stalePreviewOf(new ApiError(400, { code: 'agent_not_staffed' }))).toBeNull();
    expect(stalePreviewOf(new ApiError(409, { code: 'preview_stale' }))).toBeNull();
    expect(stalePreviewOf(new Error('network'))).toBeNull();
  });
});

describe('operationAgentCount', () => {
  it('counts targets, never ids', () => {
    expect(operationAgentCount({ kind: 'rebalance', agent_user_ids: ['a', 'b', 'c'] })).toBe(3);
    expect(operationAgentCount({ kind: 'unassign', from_user_id: 'a' })).toBe(0);
    expect(operationAgentCount({ kind: 'reassign', from_user_id: 'a', to_user_id: 'b' })).toBe(1);
  });
});

describe('splitValues', () => {
  it('splits on commas and lines, trims, and drops blanks and repeats', () => {
    expect(splitValues(' North ,East\n\nNorth,')).toEqual(['North', 'East']);
  });
});

describe('rosterLinkFor', () => {
  it('links to the roster narrowed to an owner and states, in the roster’s own encoding', () => {
    const link = rosterLinkFor('camp-1', 'agent-1', ['pending']);
    expect(link.startsWith('/agency/campaigns/camp-1/contacts?')).toBe(true);
    const params = new URLSearchParams(link.split('?')[1]);
    expect(rosterFiltersFromParams(params)).toEqual({ state: ['pending'], assigned_to: ['agent-1'] });
  });
});

describe('row selection', () => {
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];

  it('toggles one row and moves the anchor', () => {
    const one = toggleRow(EMPTY_SELECTION, ids, 'r2', true, false);
    expect([...one.selected]).toEqual(['r2']);
    expect(one.anchor).toBe('r2');
    const off = toggleRow(one, ids, 'r2', false, false);
    expect(off.selected.size).toBe(0);
  });

  it('shift-click selects the whole range from the anchor, in either direction', () => {
    const anchored = toggleRow(EMPTY_SELECTION, ids, 'r4', true, false);
    const range = toggleRow(anchored, ids, 'r2', true, true);
    expect(selectedInOrder(range, ids)).toEqual(['r2', 'r3', 'r4']);
    // The anchor stays put, so a second shift-click re-ranges from it.
    expect(range.anchor).toBe('r4');
    const cleared = toggleRow(range, ids, 'r3', false, true);
    expect(selectedInOrder(cleared, ids)).toEqual(['r2']);
  });

  it('a shift-click with no anchor acts on the one row', () => {
    expect(selectedInOrder(toggleRow(EMPTY_SELECTION, ids, 'r3', true, true), ids)).toEqual(['r3']);
  });

  it('stops adding at the cap', () => {
    const anchored = toggleRow(EMPTY_SELECTION, ids, 'r1', true, false, 3);
    const range = toggleRow(anchored, ids, 'r5', true, true, 3);
    expect(range.selected.size).toBe(3);
  });

  it('select page ticks every row up to the cap, and pressed again clears', () => {
    const page = togglePage(EMPTY_SELECTION, ids, 4);
    expect(selectedInOrder(page, ids)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(togglePage(page, ids, 4).selected.size).toBe(0);
  });
});
