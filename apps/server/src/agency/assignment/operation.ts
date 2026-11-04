/**
 * Contact assignment operations: the request validator, the canonical (normalised) form the
 * repository plans from, the preview token, and the rebalance arithmetic. A LEAF module: pure
 * functions, no I/O, so every rule here is unit-tested without a database.
 *
 * ── The preview token ───────────────────────────────────────────────────────
 * `v1.<base64url JSON>` carrying a hash of the canonical operation (its seed included) and the
 * plan's fingerprint: `planned` (selected, non-live rows), `moving`, `to_pool`, `skipped_live`,
 * `same_number_groups`, and `digest`, a `bit_xor` of a 64-bit hash of every move
 * `(contact id, from, to)`. The commit recomputes the same plan inside its transaction, under
 * row locks, and writes only when every one of those equals the token (`gate` in
 * `assignment.repository.ts`), so the moves written are the moves previewed, contact for
 * contact, not merely the same counts. The token is not secret and needs no signature: a
 * hand-made token that matches the roster as it stands commits exactly what a preview would
 * have shown.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AGENCY_ASSIGNMENT_RANGE_MAX,
  type AgencyAssignmentOperation,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyContactState } from '@magick-agency/contracts/agency';
import { UUID_RE } from '../../utils/uuid.js';
import { CONTACT_STATES } from '../spine-filters.js';

/** At most this many agents named in one operation. */
export const ASSIGNMENT_MAX_AGENTS = 200;
/** `count` on `count` / `reassign` / `unassign`: at most a million-row roster. */
export const ASSIGNMENT_MAX_COUNT = 1_000_000;
const SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

const uuid = z.string().regex(UUID_RE, 'must be a UUID');
const agentList = z.array(uuid).min(1).max(ASSIGNMENT_MAX_AGENTS)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'must not repeat an agent');
const contactIds = z.array(uuid).min(1).max(AGENCY_ASSIGNMENT_RANGE_MAX);
const count = z.number().int().min(1).max(ASSIGNMENT_MAX_COUNT);
const seed = z.string().regex(SEED_RE, 'must be 1-64 letters, digits, - or _');
const grouping = { group_same_number: z.boolean().optional() };

const contactFilter = z.object({
  states: z.array(z.enum(CONTACT_STATES as unknown as [AgencyContactState, ...AgencyContactState[]])).min(1).max(6).optional(),
  last_dispositions: z.array(z.string().min(1).max(50)).min(1).max(50).optional(),
  column: z.object({
    name: z.string().trim().min(1).max(200),
    values: z.array(z.string().max(500)).min(1).max(100),
  }).strict().optional(),
}).strict().refine((f) => f.states !== undefined || f.last_dispositions !== undefined || f.column !== undefined, {
  message: 'set at least one of states, last_dispositions, column',
});

export const assignmentOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('random_split'), agent_user_ids: agentList, only_unassigned: z.boolean().optional(), seed: seed.optional(), ...grouping }).strict(),
  z.object({ kind: z.literal('count'), agent_user_id: uuid, count, ...grouping }).strict(),
  z.object({
    kind: z.literal('filter'), agent_user_ids: agentList, filter: contactFilter,
    only_unassigned: z.boolean().optional(), seed: seed.optional(), ...grouping,
  }).strict(),
  z.object({ kind: z.literal('range'), agent_user_id: uuid, contact_ids: contactIds, ...grouping }).strict(),
  z.object({ kind: z.literal('reassign'), from_user_id: uuid, to_user_id: uuid, count: count.optional(), ...grouping }).strict(),
  z.object({ kind: z.literal('unassign'), from_user_id: uuid.optional(), count: count.optional(), contact_ids: contactIds.optional(), ...grouping }).strict(),
  z.object({ kind: z.literal('rebalance'), agent_user_ids: agentList.refine((ids) => ids.length >= 2, 'name at least two agents'), ...grouping }).strict(),
]).superRefine((o, ctx) => {
  if (o.kind === 'reassign' && o.from_user_id.toLowerCase() === o.to_user_id.toLowerCase()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must differ from from_user_id', path: ['to_user_id'] });
  }
  if (o.kind === 'unassign') {
    if ((o.from_user_id === undefined) === (o.contact_ids === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'name exactly one of from_user_id, contact_ids', path: ['from_user_id'] });
    }
    if (o.count !== undefined && o.from_user_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'count goes with from_user_id', path: ['count'] });
    }
  }
});

export const assignmentCommitSchema = z.object({
  operation: z.unknown(),
  preview_token: z.string().min(1).max(2000),
}).strict();

/** The operation as the repository plans it: defaults applied, ids lower-cased, values trimmed. */
export type CanonicalAssignment =
  | { kind: 'random_split'; agents: string[]; onlyUnassigned: boolean; seed: string; group: boolean }
  | { kind: 'count'; agent: string; count: number; group: boolean }
  | { kind: 'filter'; agents: string[]; filter: CanonicalContactFilter; onlyUnassigned: boolean; seed: string | null; group: boolean }
  | { kind: 'range'; agent: string; contactIds: string[]; group: boolean }
  | { kind: 'reassign'; from: string; to: string; count: number | null; group: boolean }
  | { kind: 'unassign'; from: string | null; count: number | null; contactIds: string[] | null; group: boolean }
  | { kind: 'rebalance'; agents: string[]; group: boolean };

export interface CanonicalContactFilter {
  states: AgencyContactState[] | null;
  lastDispositions: string[] | null;
  column: { name: string; values: string[] } | null;
}

export type AssignmentParse =
  | { ok: true; op: CanonicalAssignment }
  | { ok: false; details: Record<string, string> };

/** A server-picked seed for a random order: 16 url-safe characters. */
export function newSeed(): string {
  return randomBytes(12).toString('base64url');
}

const lower = (id: string) => id.toLowerCase();
const uniqSorted = <T extends string>(xs: readonly T[]) => [...new Set(xs)].sort();

/** Zod issues → `{ "field.path": message }`, the `assignment_invalid` details. */
function zodDetails(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : 'operation';
    out[key] ??= issue.message;
  }
  return out;
}

/**
 * Validate and normalise an operation. `phase` decides the seed rule: a preview without a
 * seed gets one picked here (the response returns it); a commit of a random order must send
 * the preview's seed back, since a fresh seed would be a split nobody previewed.
 */
export function parseAssignmentOperation(raw: unknown, phase: 'preview' | 'commit'): AssignmentParse {
  const parsed = assignmentOperationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, details: zodDetails(parsed.error) };
  const o = parsed.data as AgencyAssignmentOperation;
  const group = o.group_same_number ?? true;
  const needsSeed = o.kind === 'random_split' || (o.kind === 'filter' && o.agent_user_ids.length > 1);
  if (needsSeed && phase === 'commit' && !('seed' in o && o.seed)) {
    return { ok: false, details: { seed: 'send back the seed the preview returned' } };
  }
  const seedOf = (s: string | undefined) => s ?? newSeed();
  switch (o.kind) {
    case 'random_split':
      return { ok: true, op: { kind: o.kind, agents: o.agent_user_ids.map(lower), onlyUnassigned: o.only_unassigned ?? true, seed: seedOf(o.seed), group } };
    case 'count':
      return { ok: true, op: { kind: o.kind, agent: lower(o.agent_user_id), count: o.count, group } };
    case 'filter': {
      const f = o.filter;
      return {
        ok: true,
        op: {
          kind: o.kind,
          agents: o.agent_user_ids.map(lower),
          filter: {
            states: f.states ? uniqSorted(f.states) : null,
            lastDispositions: f.last_dispositions ? uniqSorted(f.last_dispositions) : null,
            column: f.column ? { name: f.column.name.trim(), values: uniqSorted(f.column.values.map((v) => v.trim())) } : null,
          },
          onlyUnassigned: o.only_unassigned ?? true,
          // A single target needs no order: the seed is dropped so the token does not depend on it.
          seed: needsSeed ? seedOf(o.seed) : null,
          group,
        },
      };
    }
    case 'range':
      return { ok: true, op: { kind: o.kind, agent: lower(o.agent_user_id), contactIds: uniqSorted(o.contact_ids.map(lower)), group } };
    case 'reassign':
      return { ok: true, op: { kind: o.kind, from: lower(o.from_user_id), to: lower(o.to_user_id), count: o.count ?? null, group } };
    case 'unassign':
      return {
        ok: true,
        op: {
          kind: o.kind,
          from: o.from_user_id ? lower(o.from_user_id) : null,
          count: o.count ?? null,
          contactIds: o.contact_ids ? uniqSorted(o.contact_ids.map(lower)) : null,
          group,
        },
      };
    case 'rebalance':
      return { ok: true, op: { kind: o.kind, agents: o.agent_user_ids.map(lower), group } };
  }
}

/** The agents an operation gives contacts to: each must hold an active staffing row. */
export function receivingAgents(op: CanonicalAssignment): string[] {
  switch (op.kind) {
    case 'random_split':
    case 'filter':
    case 'rebalance':
      return op.agents;
    case 'count':
    case 'range':
      return [op.agent];
    case 'reassign':
      return [op.to];
    case 'unassign':
      return [];
  }
}

/** The seed a preview reports: the random order's, else null. */
export function seedOf(op: CanonicalAssignment): string | null {
  return op.kind === 'random_split' || op.kind === 'filter' ? op.seed : null;
}

/** The order `per_agent` lists agents in: the operation's own agents first, then by id. */
export function agentOrder(op: CanonicalAssignment): string[] {
  switch (op.kind) {
    case 'random_split':
    case 'filter':
    case 'rebalance':
      return op.agents;
    case 'count':
    case 'range':
      return [op.agent];
    case 'reassign':
      return [op.from, op.to];
    case 'unassign':
      return op.from ? [op.from] : [];
  }
}

// ─── The plan fingerprint and the token ─────────────────────────────────────

/** What the plan statement aggregates; the token pins all of it. */
export interface PlanFingerprint {
  planned: number;
  moving: number;
  to_pool: number;
  skipped_live: number;
  groups: number;
  /** `bit_xor` of the move hashes, as text (a bigint). */
  digest: string;
}

/** A short hash of the canonical operation, seed included. */
export function operationHash(op: CanonicalAssignment): string {
  return createHash('sha256').update(JSON.stringify(op)).digest('base64url').slice(0, 22);
}

export function encodePreviewToken(op: CanonicalAssignment, fp: PlanFingerprint): string {
  const body = {
    o: operationHash(op), p: fp.planned, m: fp.moving, t: fp.to_pool, s: fp.skipped_live, g: fp.groups, d: fp.digest,
  };
  return `v1.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
}

/**
 * The fingerprint a token names, provided it was minted for THIS operation; null for a
 * token that is malformed or belongs to another operation (both: the supervisor did not
 * preview what they are committing, so the commit answers `preview_stale`).
 */
export function decodePreviewToken(token: string, op: CanonicalAssignment): PlanFingerprint | null {
  if (!token.startsWith('v1.')) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(token.slice(3), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  if (b['o'] !== operationHash(op)) return null;
  const planned = int(b['p']);
  const moving = int(b['m']);
  const toPool = int(b['t']);
  const skipped = int(b['s']);
  const groups = int(b['g']);
  const digest = typeof b['d'] === 'string' && /^-?\d{1,20}$/.test(b['d']) ? b['d'] : null;
  if (planned === null || moving === null || toPool === null || skipped === null || groups === null || digest === null) return null;
  return { planned, moving, to_pool: toPool, skipped_live: skipped, groups, digest };
}

/** The smallest preview whose counts may drift at commit ({@link commitDrift}). */
export const ASSIGNMENT_DRIFT_MIN_MOVES = 100;
/** How far a large operation's counts may drift between preview and commit. */
export const ASSIGNMENT_DRIFT_RATIO = 0.02;

/**
 * How many contacts the commit's move and to-pool counts may differ from the preview's and
 * still write (CA13). A preview moving fewer than {@link ASSIGNMENT_DRIFT_MIN_MOVES} contacts
 * gets 0: it commits only contact for contact (a supervisor reading a short list notices one
 * missing). A larger one gets 2%: on a running campaign the claims and settlements move a few
 * rows between preview and commit every second, so an exact rule would refuse almost every
 * commit there; within the drift the commit writes the plan as it now stands (same operation,
 * same seed, same agents) and reports what it moved. Pure.
 */
export function commitDrift(expected: Pick<PlanFingerprint, 'moving'>): number {
  return expected.moving >= ASSIGNMENT_DRIFT_MIN_MOVES ? Math.floor(expected.moving * ASSIGNMENT_DRIFT_RATIO) : 0;
}

// ─── Rebalance ──────────────────────────────────────────────────────────────

export interface RebalanceLoad {
  agent: string;
  /** Open (`pending`) contacts the agent holds. */
  backlog: number;
  /** Of those, open, never attempted and not callbacks: the ones that may move. */
  movable: number;
}

export interface RebalanceQuotas {
  /** Agents that give, in operation order, and how many each gives at most. */
  givers: Array<{ agent: string; give: number }>;
  /** Agents that receive, in operation order, with cumulative quota ends. */
  receivers: Array<{ agent: string; end: number }>;
}

/**
 * Who gives and who receives. The target of every agent is the average backlog, rounded
 * (`floor` or `ceil`; the agents already holding the most get the `ceil`s, so the fewest
 * contacts move). An agent above their target gives the excess, bounded by what they may
 * move; an agent below receives up to their deficit, filled in operation order. Every backlog
 * then sits within one of the average, unless the excess is held in contacts that may not
 * move (attempted, callbacks), which stay put.
 */
export function rebalanceQuotas(loads: readonly RebalanceLoad[]): RebalanceQuotas {
  const k = loads.length;
  if (k === 0) return { givers: [], receivers: [] };
  const total = loads.reduce((s, l) => s + l.backlog, 0);
  const base = Math.floor(total / k);
  const extra = total % k;
  const byLoad = loads.map((l, i) => ({ l, i })).sort((a, b) => b.l.backlog - a.l.backlog || a.i - b.i);
  const target = new Map<string, number>();
  byLoad.forEach(({ l }, rank) => target.set(l.agent, base + (rank < extra ? 1 : 0)));

  const givers = loads
    .map((l) => ({ agent: l.agent, give: Math.min(Math.max(0, l.backlog - target.get(l.agent)!), l.movable) }))
    .filter((g) => g.give > 0);
  let supply = givers.reduce((s, g) => s + g.give, 0);
  const receivers: RebalanceQuotas['receivers'] = [];
  let end = 0;
  for (const l of loads) {
    const need = Math.max(0, target.get(l.agent)! - l.backlog);
    const take = Math.min(need, supply);
    if (take <= 0) continue;
    supply -= take;
    end += take;
    receivers.push({ agent: l.agent, end });
  }
  return { givers, receivers };
}
