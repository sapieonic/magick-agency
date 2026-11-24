import { describe, expect, it } from 'vitest';
import {
  agentOrder,
  assignmentCommitSchema,
  decodePreviewToken,
  encodePreviewToken,
  parseAssignmentOperation,
  rebalanceQuotas,
  receivingAgents,
  type CanonicalAssignment,
  type PlanFingerprint,
  commitDrift,
  historyReasonOf,
  lateCallbackQuotas,
} from '../../../src/agency/assignment/operation.js';
import { zodDetails } from '../../../src/utils/zod-details.js';

/**
 * Contact assignment's pure rules: the operation validator (`400 assignment_invalid` with
 * per-field details), its canonical form, the preview token and the rebalance quotas. The SQL that plans an operation is pinned on real Postgres in
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

  it('keys details by field path, the first message per path, and a root issue by the root key', () => {
    const bad = assignmentCommitSchema.safeParse({ extra: 1, preview_token: '' });
    if (bad.success) throw new Error('expected a refusal');
    const out = zodDetails(bad.error, 'body');
    expect(Object.keys(out).sort()).toEqual(['body', 'preview_token']);
    // The operation's own parse keys a root issue `operation`.
    const root = parseAssignmentOperation(42, 'preview');
    expect(root.ok ? null : root.details).toHaveProperty('operation');
  });

  it('orders `per_agent` by the operation\'s own agents, givers included', () => {
    expect(agentOrder(ok({ kind: 'random_split', agent_user_ids: [B, A] }))).toEqual([B, A]);
    expect(agentOrder(ok({ kind: 'filter', agent_user_ids: [C], filter: { states: ['pending'] } }))).toEqual([C]);
    expect(agentOrder(ok({ kind: 'rebalance', agent_user_ids: [A, C] }))).toEqual([A, C]);
    expect(agentOrder(ok({ kind: 'count', agent_user_id: A, count: 3 }))).toEqual([A]);
    expect(agentOrder(ok({ kind: 'range', agent_user_id: B, contact_ids: [C] }))).toEqual([B]);
    expect(agentOrder(ok({ kind: 'reassign', from_user_id: A, to_user_id: B }))).toEqual([A, B]);
    expect(agentOrder(ok({ kind: 'unassign', from_user_id: C }))).toEqual([C]);
    expect(agentOrder(ok({ kind: 'unassign', contact_ids: [A] }))).toEqual([]);
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

describe('commitDrift (CA13)', () => {
  it('is 0 below 100 moves (contact for contact), and 2% rounded down from 100', () => {
    expect(commitDrift({ moving: 0 })).toBe(0);
    expect(commitDrift({ moving: 99 })).toBe(0);
    expect(commitDrift({ moving: 100 })).toBe(2);
    expect(commitDrift({ moving: 149 })).toBe(2);
    expect(commitDrift({ moving: 1_000 })).toBe(20);
    expect(commitDrift({ moving: 1_000_000 })).toBe(20_000);
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

// LF7, LF21: the late-callbacks hand-off's operation and its dealing, fewest due first.
describe('the late-callbacks hand-off (LF7)', () => {
  it('parses with no agents named, grouping by number unless told not to', () => {
    expect(ok({ kind: 'late_callbacks_to_live_agents' })).toEqual({ kind: 'late_callbacks_to_live_agents', group: true });
    expect(ok({ kind: 'late_callbacks_to_live_agents', group_same_number: false }, 'commit'))
      .toEqual({ kind: 'late_callbacks_to_live_agents', group: false });
  });

  it('refuses any field it does not take: it never names agents', () => {
    for (const extra of [{ agent_user_ids: [A] }, { seed: 'abc' }, { count: 3 }]) {
      const r = parseAssignmentOperation({ kind: 'late_callbacks_to_live_agents', ...extra }, 'preview');
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('names no receiving agent to check for staffing, and records its moves as reassign', () => {
    const op = ok({ kind: 'late_callbacks_to_live_agents' });
    expect(receivingAgents(op)).toEqual([]);
    expect(agentOrder(op)).toEqual([]);
    expect(historyReasonOf(op)).toBe('reassign');
    expect(historyReasonOf(ok({ kind: 'rebalance', agent_user_ids: [A, B] }))).toBe('rebalance');
  });

  it('its token is its own: a token minted for another kind is no token for it', () => {
    const fp: PlanFingerprint = { planned: 3, moving: 3, to_pool: 0, skipped_live: 0, groups: 0, digest: '7' };
    const late = ok({ kind: 'late_callbacks_to_live_agents' });
    expect(decodePreviewToken(encodePreviewToken(late, fp), late)).toEqual(fp);
    expect(decodePreviewToken(encodePreviewToken(ok({ kind: 'rebalance', agent_user_ids: [A, B] }), fp), late)).toBeNull();
  });
});

describe('lateCallbackQuotas: fewest callbacks due first', () => {
  it('raises the emptiest agents first, then shares what is left one each', () => {
    // A has none due, B two, C five; four callbacks: A gets three, B one (both end at 3), C none.
    expect(lateCallbackQuotas([{ agent: C, due: 5 }, { agent: B, due: 2 }, { agent: A, due: 0 }], 4)).toEqual({
      receivers: [{ agent: A, end: 3 }, { agent: B, end: 4 }],
      live: [A, B, C],
    });
    // Five: level 3 with one over, to the first in order (A).
    expect(lateCallbackQuotas([{ agent: A, due: 0 }, { agent: B, due: 2 }, { agent: C, due: 5 }], 5).receivers)
      .toEqual([{ agent: A, end: 4 }, { agent: B, end: 5 }]);
    // Twelve: everyone reaches 6 (6 + 4 + 1 = 11), the twelfth to A.
    expect(lateCallbackQuotas([{ agent: A, due: 0 }, { agent: B, due: 2 }, { agent: C, due: 5 }], 12).receivers)
      .toEqual([{ agent: A, end: 7 }, { agent: B, end: 11 }, { agent: C, end: 12 }]);
  });

  it('breaks ties by agent id, and deals evenly among equals', () => {
    expect(lateCallbackQuotas([{ agent: C, due: 1 }, { agent: A, due: 1 }, { agent: B, due: 1 }], 7)).toEqual({
      receivers: [{ agent: A, end: 3 }, { agent: B, end: 5 }, { agent: C, end: 7 }],
      live: [A, B, C],
    });
  });

  it('gives every callback away, no more, and leaves every receiver within one of the level', () => {
    for (let total = 0; total <= 30; total += 1) {
      const loads = [{ agent: A, due: 4 }, { agent: B, due: 0 }, { agent: C, due: 9 }];
      const { receivers } = lateCallbackQuotas(loads, total);
      expect(receivers.at(-1)?.end ?? 0, String(total)).toBe(total);
      const after = new Map(loads.map((l) => [l.agent, l.due]));
      let prev = 0;
      for (const r of receivers) {
        after.set(r.agent, after.get(r.agent)! + (r.end - prev));
        prev = r.end;
      }
      const raised = loads.filter((l) => after.get(l.agent)! > l.due).map((l) => after.get(l.agent)!);
      if (raised.length > 0) {
        expect(Math.max(...raised) - Math.min(...raised), String(total)).toBeLessThanOrEqual(1);
        // Nobody is left more than one below a raised agent (the extras go to the fewest at the start).
        for (const v of after.values()) expect(v, String(total)).toBeGreaterThanOrEqual(Math.max(...raised) - 1);
      }
    }
  });

  it('deals nothing with nobody live or nothing late', () => {
    expect(lateCallbackQuotas([], 5)).toEqual({ receivers: [], live: [] });
    expect(lateCallbackQuotas([{ agent: A, due: 2 }], 0)).toEqual({ receivers: [], live: [A] });
  });
});
