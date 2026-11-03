import { describe, expect, it } from 'vitest';
import {
  decodePreviewToken,
  encodePreviewToken,
  parseAssignmentOperation,
  rebalanceQuotas,
  receivingAgents,
  type CanonicalAssignment,
  type PlanFingerprint,
} from '../../../src/agency/assignment/operation.js';
import { computeQueueState } from '../../../src/agency/assignment/queue-state.js';

/**
 * Contact assignment's pure rules: the operation validator (`400 assignment_invalid` with
 * per-field details), its canonical form, the preview token, the rebalance quotas and the
 * agent's queue state. The SQL that plans an operation is pinned on real Postgres in
 * `test/integration/agency/assignment-repository.test.ts`.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function ok(raw: unknown, phase: 'preview' | 'commit' = 'preview'): CanonicalAssignment {
  const r = parseAssignmentOperation(raw, phase);
  if (!r.ok) throw new Error(JSON.stringify(r.details));
  return r.op;
}
function details(raw: unknown, phase: 'preview' | 'commit' = 'preview'): Record<string, string> {
  const r = parseAssignmentOperation(raw, phase);
  if (r.ok) throw new Error('expected a refusal');
  return r.details;
}

describe('parseAssignmentOperation', () => {
  it('accepts every kind and applies the defaults', () => {
    expect(ok({ kind: 'random_split', agent_user_ids: [A, B], seed: 'abc' })).toEqual({
      kind: 'random_split', agents: [A, B], onlyUnassigned: true, seed: 'abc', group: true,
    });
    expect(ok({ kind: 'count', agent_user_id: A.toUpperCase(), count: 10, group_same_number: false })).toEqual({
      kind: 'count', agent: A, count: 10, group: false,
    });
    expect(ok({ kind: 'filter', agent_user_ids: [A], filter: { column: { name: ' Region ', values: [' North', 'East '] } } })).toEqual({
      kind: 'filter', agents: [A], onlyUnassigned: true, seed: null, group: true,
      filter: { states: null, lastDispositions: null, column: { name: 'Region', values: ['East', 'North'] } },
    });
    expect(ok({ kind: 'range', agent_user_id: A, contact_ids: [C, B, C] })).toMatchObject({ contactIds: [B, C] });
    expect(ok({ kind: 'reassign', from_user_id: A, to_user_id: B })).toEqual({ kind: 'reassign', from: A, to: B, count: null, group: true });
    expect(ok({ kind: 'unassign', from_user_id: A, count: 3 })).toMatchObject({ from: A, count: 3, contactIds: null });
    expect(ok({ kind: 'unassign', contact_ids: [C] })).toMatchObject({ from: null, contactIds: [C] });
    expect(ok({ kind: 'rebalance', agent_user_ids: [A, B] })).toEqual({ kind: 'rebalance', agents: [A, B], group: true });
  });

  it('picks a seed on a preview of a random order and demands it back on the commit', () => {
    const op = ok({ kind: 'random_split', agent_user_ids: [A, B] });
    expect(op.kind === 'random_split' && op.seed).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(details({ kind: 'random_split', agent_user_ids: [A, B] }, 'commit')).toEqual({ seed: 'send back the seed the preview returned' });
    expect(details({ kind: 'filter', agent_user_ids: [A, B], filter: { states: ['pending'] } }, 'commit')).toHaveProperty('seed');
    // One target: no order, no seed.
    expect(ok({ kind: 'filter', agent_user_ids: [A], filter: { states: ['pending'] }, seed: 'x' }, 'commit')).toMatchObject({ seed: null });
  });

  it.each([
    [{ kind: 'nope' }, 'kind'],
    [{ kind: 'count', agent_user_id: 'not-a-uuid', count: 1 }, 'agent_user_id'],
    [{ kind: 'count', agent_user_id: A, count: 0 }, 'count'],
    [{ kind: 'count', agent_user_id: A, count: 1.5 }, 'count'],
    [{ kind: 'count', agent_user_id: A, count: 1, extra: true }, 'operation'],
    [{ kind: 'random_split', agent_user_ids: [] }, 'agent_user_ids'],
    [{ kind: 'random_split', agent_user_ids: [A, A.toUpperCase()] }, 'agent_user_ids'],
    [{ kind: 'random_split', agent_user_ids: [A], seed: 'has space' }, 'seed'],
    [{ kind: 'filter', agent_user_ids: [A], filter: {} }, 'filter'],
    [{ kind: 'filter', agent_user_ids: [A], filter: { states: ['dialing'] } }, 'filter.states.0'],
    [{ kind: 'range', agent_user_id: A, contact_ids: Array.from({ length: 501 }, () => C) }, 'contact_ids'],
    [{ kind: 'range', agent_user_id: A, contact_ids: ['x'] }, 'contact_ids.0'],
    [{ kind: 'reassign', from_user_id: A, to_user_id: A }, 'to_user_id'],
    [{ kind: 'unassign' }, 'from_user_id'],
    [{ kind: 'unassign', from_user_id: A, contact_ids: [C] }, 'from_user_id'],
    [{ kind: 'unassign', contact_ids: [C], count: 2 }, 'count'],
    [{ kind: 'rebalance', agent_user_ids: [A] }, 'agent_user_ids'],
  ])('refuses %j with a detail on %s', (raw, field) => {
    expect(Object.keys(details(raw))).toContain(field);
  });

  it('names the receivers every kind must find staffed', () => {
    expect(receivingAgents(ok({ kind: 'reassign', from_user_id: A, to_user_id: B }))).toEqual([B]);
    expect(receivingAgents(ok({ kind: 'unassign', from_user_id: A }))).toEqual([]);
    expect(receivingAgents(ok({ kind: 'random_split', agent_user_ids: [A, B, C] }))).toEqual([A, B, C]);
  });
});

describe('the preview token', () => {
  const fp: PlanFingerprint = { planned: 10, moving: 7, to_pool: 0, skipped_live: 2, groups: 1, digest: '-9123372036854775808' };

  it('round-trips the fingerprint for the same operation (seed included)', () => {
    const op = ok({ kind: 'random_split', agent_user_ids: [A, B], seed: 's1' });
    expect(decodePreviewToken(encodePreviewToken(op, fp), op)).toEqual(fp);
  });

  it('is refused for another operation, another seed, or garbage', () => {
    const op = ok({ kind: 'random_split', agent_user_ids: [A, B], seed: 's1' });
    const token = encodePreviewToken(op, fp);
    expect(decodePreviewToken(token, ok({ kind: 'random_split', agent_user_ids: [A, B], seed: 's2' }))).toBeNull();
    expect(decodePreviewToken(token, ok({ kind: 'random_split', agent_user_ids: [B, A], seed: 's1' }))).toBeNull();
    expect(decodePreviewToken('v1.not-json', op)).toBeNull();
    expect(decodePreviewToken('v2.' + token.slice(3), op)).toBeNull();
  });
});

describe('rebalanceQuotas', () => {
  it('moves the excess above the rounded average to those below, within one', () => {
    const q = rebalanceQuotas([
      { agent: A, backlog: 10, movable: 10 },
      { agent: B, backlog: 2, movable: 2 },
      { agent: C, backlog: 0, movable: 0 },
    ]);
    // 12 / 3 = 4 each: A gives 6, B receives 2, C receives 4.
    expect(q.givers).toEqual([{ agent: A, give: 6 }]);
    expect(q.receivers).toEqual([{ agent: B, end: 2 }, { agent: C, end: 6 }]);
  });

  it('gives the ceil targets to the heaviest agents, and never more than they may move', () => {
    const q = rebalanceQuotas([
      { agent: A, backlog: 8, movable: 1 },
      { agent: B, backlog: 3, movable: 3 },
    ]);
    // 11 / 2: A's target 6, B's 5. A may move only 1.
    expect(q.givers).toEqual([{ agent: A, give: 1 }]);
    expect(q.receivers).toEqual([{ agent: B, end: 1 }]);
  });

  it('does nothing when already balanced', () => {
    expect(rebalanceQuotas([{ agent: A, backlog: 5, movable: 5 }, { agent: B, backlog: 4, movable: 4 }]))
      .toEqual({ givers: [], receivers: [] });
  });
});

describe('computeQueueState', () => {
  const base = { windowOpen: true, nextWindowOpenAt: null, dueNow: 0, open: 3, openNonCallback: 3, nextAttemptAt: new Date('2026-11-03T15:00:00Z') };
  it.each([
    [{ dueNow: 2 }, { due: true, reason: null }],
    [{ open: 0 }, { due: false, reason: 'queue_empty', next_due_at: null }],
    [{ windowOpen: false, dueNow: 1, nextWindowOpenAt: new Date('2026-11-04T09:00:00Z') }, { due: false, reason: 'outside_calling_hours', next_due_at: '2026-11-04T09:00:00.000Z' }],
    [{ openNonCallback: 0 }, { due: false, reason: 'callbacks_later', next_due_at: '2026-11-03T15:00:00.000Z' }],
    [{}, { due: false, reason: 'waiting_for_retry', next_due_at: '2026-11-03T15:00:00.000Z' }],
  ])('%j → %j', (over, expected) => {
    expect(computeQueueState({ ...base, ...over })).toMatchObject(expected);
  });
});
