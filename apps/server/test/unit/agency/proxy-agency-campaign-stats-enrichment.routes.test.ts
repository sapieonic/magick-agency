import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 *  - There is no `credits_low` overlay (no billing): the describe keeps one pass-through case
 *    ("leaves stall and other_stalls untouched") and "never adds a credits_low stall, and
 *    issues no credit read" pins the overlay's absence at the route.
 *  - The pg-pool boundary is `@magick-agency/db/connection` (the shared repositories import
 *    `../connection.js`, the same module); the fake pool keeps SQL-driven predicates
 *    (`m.tenant_id = $2` still matches `$2::uuid`).
 *  - `agents_peak`: no producer here or in the internal handler; it is never served (pinned below).
 */

/**
 * **`GET /proxy/agency/campaigns/:id/stats` must PRODUCE the two fields the internal handler
 * declares and cannot fill.**
 *
 * ── What is deliberately NOT mocked ───────────────────────────────────────────
 * `src/agency/agency-stats-enrichment.js` and `src/db/repositories/user.repository.js`
 * are REAL here. They are the fix. A test
 * that stubs the enricher passes identically before and after it exists, which is
 * the standard `proxy-agency-campaign-behavioral-capabilities.routes.test.ts` set
 * and the trap `proxy-agency-campaigns.routes.test.ts` documents about itself.
 *
 * In particular the tenant scope is only real if the SQL is real. So the mock
 * boundary is the **pg pool**, and the fake below derives its filtering FROM THE
 * SQL TEXT it is handed: it applies a tenant predicate only when the statement
 * contains one. Delete `m.tenant_id = $2` from `findDisplayNamesInTenant` and the
 * fake stops scoping, the foreign-tenant agent resolves to a name, and
 * "an agent_user_id from another tenant resolves to null" goes red. A fake that
 * scoped unconditionally would pass either way and prove nothing — see the
 * "mocked pool hides SQL drift" failure mode.
 *
 * ── The property that is easiest to break and hardest to see ─────────────────
 * Byte-identity. With names resolving, the public API layer's body must be
 * the internal handler's body plus one `agent_name` key per agent row: same keys, same order,
 * same values. `expect(JSON.stringify(...))` on the stripped body is the assertion,
 * not a field-by-field walk — a field-by-field walk cannot see a dropped field
 * the internal handler adds next (for example `agents[].last_heartbeat`).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

const AGENT_RAVI = 'aaaaaaaa-0000-4000-8000-000000000001';
const AGENT_SUNITA = 'aaaaaaaa-0000-4000-8000-000000000002';
/** Belongs to OTHER_TENANT. The leak case. */
const AGENT_FOREIGN = 'aaaaaaaa-0000-4000-8000-000000000003';
/** Soft-deleted in THIS tenant. */
const AGENT_DELETED = 'aaaaaaaa-0000-4000-8000-000000000004';
/** In this tenant, never set a display name. */
const AGENT_NO_NAME = 'aaaaaaaa-0000-4000-8000-000000000005';
/** Not UUID-shaped. Reaches Postgres as `22P02` if it is not filtered first. */
const AGENT_GARBAGE = 'not-a-uuid';

interface SeedUser {
  id: string;
  tenant_id: string;
  display_name: string | null;
  email: string;
  status: 'active' | 'inactive' | 'deleted';
}

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// RBAC and governance each have their own execution-based suite next door
// (`...lifecycle-rbac...`, `...behavioral-capabilities...`). Here they are no-ops
// so a non-200 can only ever mean the enrichment did something wrong.
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
// Cache is an I/O edge; a miss forces the real DB-then-DEFAULT_RATES path.
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  },
}));
// The route module's other collaborators — untouched by these cases, but
// importing the module pulls them in.
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(),
  getFile: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));

// ── The one mocked boundary that matters: the pg pool ────────────────────────
vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { enrichAgencyCampaignStats } from '../../../src/agency/agency-stats-enrichment.js';
import type { AgencyCampaignStatsAdditions } from '../../../src/agency/agency-campaign-wire.js';

const PREFIX = '/proxy/agency';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';

const SEED_USERS: SeedUser[] = [
  { id: AGENT_RAVI, tenant_id: TENANT, display_name: 'Ravi', email: 'ravi@example.com', status: 'active' },
  { id: AGENT_SUNITA, tenant_id: TENANT, display_name: 'Sunita', email: 'sunita@example.com', status: 'active' },
  { id: AGENT_FOREIGN, tenant_id: OTHER_TENANT, display_name: 'Priya', email: 'priya@other.example', status: 'active' },
  { id: AGENT_DELETED, tenant_id: TENANT, display_name: 'Gone', email: 'gone@example.com', status: 'deleted' },
  { id: AGENT_NO_NAME, tenant_id: TENANT, display_name: null, email: 'anon@example.com', status: 'active' },
];

/** Statements the fake pool was asked to run, for the N+1 assertion. */
let statements: string[] = [];
/** Forced failure for the degradation cases. */
let userQueryError: Error | null = null;

/**
 * A pg double whose behaviour is a FUNCTION OF THE SQL, so dropping a predicate
 * from the SQL changes what the tests see. It does not interpret SQL in
 * general — it recognises the three statements this path issues and applies the
 * predicates those statements actually contain.
 */
function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[] } {
  statements.push(sql);

  if (sql.includes('FROM users')) {
    if (userQueryError) throw userQueryError;
    const ids = (params[0] as string[]) ?? [];
    const tenantParam = params[1] as string | undefined;

    // A non-UUID reaching Postgres in a `::uuid[]` cast is `22P02`, not an empty
    // result. Reproduce that, so filtering ids in JS is load-bearing here too.
    for (const id of ids) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      }
    }

    // ── The predicates, applied only when the statement carries them ──────────
    const scopesToTenant = /m\.tenant_id\s*=\s*\$2/.test(sql);
    const excludesDeleted = /u\.status\s*<>\s*'deleted'/.test(sql);

    const rows = SEED_USERS.filter((u) => ids.includes(u.id))
      .filter((u) => (scopesToTenant ? u.tenant_id === tenantParam : true))
      .filter((u) => (excludesDeleted ? u.status !== 'deleted' : true))
      .map((u) => ({ id: u.id, display_name: u.display_name, email: u.email }));
    return { rows };
  }

  return { rows: [] };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as unknown as Record<string, unknown>)['tenantId'] = TENANT;
    (request as unknown as Record<string, unknown>)['accountId'] = ACCOUNT;
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** A stats body in the internal handler's real shape, with the roster the internal handler ships. */
function coreStatsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: CAMPAIGN,
    status: 'dialing',
    contacts_total: 400,
    contacts_pending: 120,
    contacts_in_flight: 3,
    contacts_completed: 260,
    contacts_suppressed: 12,
    contacts_exhausted: 5,
    retries_pending: 7,
    attempts_live: 3,
    attempts_total: 900,
    attempts_connected: 240,
    agents_live: 2,
    abandoned_24h: 4,
    answered_24h: 200,
    abandonment_rate_24h_pct: 2.0,
    agents_by_state: { available: 1, on_call: 1, wrap_up: 0, break: 0, offline: 0 },
    agents: [
      {
        session_id: 'sess-1',
        agent_user_id: AGENT_RAVI,
        state: 'on_call',
        state_since: '2026-08-15T09:00:00.000Z',
        // A field this suite does not know about, standing in for a future
        // `last_heartbeat`. It must survive.
        last_heartbeat: '2026-08-15T09:04:55.000Z',
        break_reason: null,
        calls_handled: 12,
      },
      {
        session_id: 'sess-2',
        agent_user_id: AGENT_SUNITA,
        state: 'available',
        state_since: '2026-08-15T09:03:00.000Z',
        last_heartbeat: '2026-08-15T09:04:58.000Z',
        break_reason: null,
        calls_handled: 9,
      },
    ],
    human_connects: 180,
    machine_connects: 50,
    unclassified_connects: 10,
    stall: null,
    other_stalls: [],
    ...overrides,
  };
}

async function getStats(app: FastifyInstance): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/stats` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The body with every `agent_name` key removed, for byte-identity comparison. */
function stripAgentNames(body: Record<string, unknown>): Record<string, unknown> {
  const agents = body['agents'] as Record<string, unknown>[] | undefined;
  if (!agents) return body;
  return {
    ...body,
    agents: agents.map((row) => {
      const { agent_name: _dropped, ...rest } = row;
      return rest;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  statements = [];
  userQueryError = null;
  mocks.query.mockImplementation(fakeQuery);
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: coreStatsBody(), headers: new Headers() });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('agent_name — the field only the public API layer can fill', () => {
  it('is present on every agent row and carries the display name', async () => {
    const app = await buildApp();
    const body = await getStats(app);
    const agents = body['agents'] as Record<string, unknown>[];

    expect(agents.map((a) => a['agent_name'])).toEqual(['Ravi', 'Sunita']);
  });

  it('resolves the WHOLE roster in one query, not one per agent', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: Array.from({ length: 25 }, (_, i) => ({
          session_id: `sess-${i}`,
          agent_user_id: i % 2 === 0 ? AGENT_RAVI : AGENT_SUNITA,
          state: 'available',
          state_since: '2026-08-15T09:00:00.000Z',
          break_reason: null,
          calls_handled: i,
        })),
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    const userStatements = statements.filter((s) => s.includes('FROM users'));
    expect(userStatements).toHaveLength(1);
    expect((body['agents'] as Record<string, unknown>[])).toHaveLength(25);
  });

  it('sends ONE parameterised id set, deduped — not a statement per agent', async () => {
    const app = await buildApp();
    await getStats(app);

    const call = mocks.query.mock.calls.find(([sql]) => String(sql).includes('FROM users'));
    expect(call).toBeDefined();
    expect(call![1][0]).toEqual([AGENT_RAVI, AGENT_SUNITA]);
  });

  /**
   * THE LEAK CASE. `agent_user_id` comes back from the internal handler, which holds no user
   * table and does no tenant checking on it. Without the tenant predicate this
   * renders another tenant's employee on this tenant's dashboard.
   */
  it('resolves an agent_user_id from ANOTHER tenant to null, never to that tenant’s name', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: [
          { session_id: 's1', agent_user_id: AGENT_RAVI, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 },
          { session_id: 's2', agent_user_id: AGENT_FOREIGN, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 },
        ],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    const agents = body['agents'] as Record<string, unknown>[];

    expect(agents[0]!['agent_name']).toBe('Ravi');
    expect(agents[1]!['agent_name']).toBeNull();
    // Stated as its own assertion, because "is null" and "is not Priya" fail
    // for different reasons and only the second one is the leak.
    expect(JSON.stringify(body)).not.toContain('Priya');
  });

  it('resolves a soft-deleted user to null', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: [{ session_id: 's1', agent_user_id: AGENT_DELETED, state: 'offline', state_since: 'x', break_reason: null, calls_handled: 0 }],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    expect((body['agents'] as Record<string, unknown>[])[0]!['agent_name']).toBeNull();
  });

  it('resolves an unknown user id to null rather than a placeholder string', async () => {
    const unknown = 'aaaaaaaa-0000-4000-8000-00000000ffff';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: [{ session_id: 's1', agent_user_id: unknown, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 }],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    const name = (body['agents'] as Record<string, unknown>[])[0]!['agent_name'];

    expect(name).toBeNull();
    expect(name).not.toBe('Unknown');
  });

  /**
   * A non-UUID id must never reach the `::uuid[]` cast — Postgres answers `22P02`
   * from inside a 5-second-polled read, which is a 500, not an empty result.
   */
  it('survives a non-UUID agent_user_id without a 500, resolving it to null', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: [
          { session_id: 's1', agent_user_id: AGENT_GARBAGE, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 },
          { session_id: 's2', agent_user_id: AGENT_RAVI, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 },
        ],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    const agents = body['agents'] as Record<string, unknown>[];

    expect(agents[0]!['agent_name']).toBeNull();
    expect(agents[1]!['agent_name']).toBe('Ravi');
  });

  /**
   * A user with no `display_name` is RESOLVED — a different fact from "the public API layer
   * cannot identify this person". Collapsing the two would make a missing
   * profile field read to the console exactly like a cross-tenant miss.
   */
  it('falls back to the email for a resolved user with no display name', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        agents: [{ session_id: 's1', agent_user_id: AGENT_NO_NAME, state: 'available', state_since: 'x', break_reason: null, calls_handled: 0 }],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    expect((body['agents'] as Record<string, unknown>[])[0]!['agent_name']).toBe('anon@example.com');
  });

  /**
   * Degradation shape. An absent key is the defect this ticket exists to fix, so
   * a failed lookup still produces the key — with `null`.
   */
  it('still emits agent_name: null on every row when the lookup throws, and stays 200', async () => {
    userQueryError = new Error('connection terminated unexpectedly');

    const app = await buildApp();
    const body = await getStats(app);
    const agents = body['agents'] as Record<string, unknown>[];

    for (const row of agents) {
      expect(row).toHaveProperty('agent_name');
      expect(row['agent_name']).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the credits_low stall arm — the diagnosis only the public API layer can make', () => {
  // The pass-through half of this describe: whatever stall the internal handler diagnosed
  // reaches the client as the internal handler sent it.
  it('leaves stall and other_stalls untouched when credit is healthy', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({
        stall: { code: 'elevated_failure_rate', failed_pct: 40, attempts: 100, window_minutes: 15 },
        other_stalls: ['outside_calling_hours'],
      }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    expect((body['stall'] as Record<string, unknown>)['code']).toBe('elevated_failure_rate');
    expect(body['other_stalls']).toEqual(['outside_calling_hours']);
  });

  // The overlay's absence, at the route. A zero-balance tenant used to
  // be the case that fired it; now nothing reads a balance or a rate, and the stall the internal handler
  // sent (none here) is what the client gets.
  it('never adds a credits_low stall, and issues no credit read', async () => {
    const app = await buildApp();
    const body = await getStats(app);

    expect(body['stall']).toBeNull();
    expect(body['other_stalls']).toEqual([]);
    expect(statements.some((sql) => /credit/i.test(sql))).toBe(false);
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('everything else passes through byte-identically', () => {
  it('is the internal handler’s exact body once the agent_name keys are removed', async () => {
    const core = coreStatsBody();
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: core, headers: new Headers() });

    const app = await buildApp();
    const body = await getStats(app);

    // Serialised, not deep-equal: key ORDER and unknown fields both matter, and a
    // field-by-field walk sees neither.
    expect(JSON.stringify(stripAgentNames(body))).toBe(JSON.stringify(core));
  });

  it('appends agent_name AFTER the keys the internal handler sent, leaving their order intact', async () => {
    const app = await buildApp();
    const body = await getStats(app);
    const row = (body['agents'] as Record<string, unknown>[])[0]!;

    expect(Object.keys(row)).toEqual([
      'session_id',
      'agent_user_id',
      'state',
      'state_since',
      'last_heartbeat',
      'break_reason',
      'calls_handled',
      'agent_name',
    ]);
  });

  it('forwards a field this repo has never heard of, untouched', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({ some_field_added_next_quarter: { nested: [1, 2, 3] } }),
    });

    const app = await buildApp();
    const body = await getStats(app);
    expect(body['some_field_added_next_quarter']).toEqual({ nested: [1, 2, 3] });
  });

  it('leaves a non-2xx body completely alone', async () => {
    const errorBody = { error: 'Not Found', code: 'campaign_not_found' };
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: errorBody, headers: new Headers() });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/stats` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(errorBody);
    // No enrichment work at all on an error body.
    expect(statements).toHaveLength(0);
  });

  it('does not invent an agents array the internal handler did not send', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { campaign_id: CAMPAIGN, status: 'draft' },
    });

    const app = await buildApp();
    const body = await getStats(app);
    expect(body).not.toHaveProperty('agents');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('P2: the internal handler’s new success fields reach the client untouched', () => {
  /**
   * The internal handler's campaign-stats payload gains two members — `attempts_success` (a count)
   * and `success_rate_pct` (a percentage, **nullable**). The public API layer produces neither and
   * has no opinion about either: they are the internal handler's arithmetic over its own
   * dispositions.
   *
   * ── Why this needs a test when the code needed no change ──────────────────
   * It needed none because `enrichAgencyCampaignStats` is a SPREAD over the internal handler's
   * body rather than a reconstruction from a field list, and its docstring says so
   * in as many words. That is the whole reason a new internal handler field arrives without
   * this repo being edited — and it is exactly the property a well-meaning
   * "let's be explicit about the response shape" refactor deletes. The
   * byte-identity block above proves it generically with a made-up key; this block
   * names the two REAL fields, so the failure message points at the real field rather
   * than at a placeholder.
   *
   * ── `success_rate_pct: null` is the case that matters ─────────────────────
   * `null` means "no attempts, so no rate" — a campaign that has not dialled yet,
   * or a filter window with nothing in it. **It must not be coerced to `0`
   * anywhere on this path.** Zero is a measured claim ("we tried and never
   * succeeded") and null is the absence of one; a console rendering 0% success on a
   * campaign that has made no calls is a supervisor being told their team failed at
   * something it has not done. The distinction survives only if every hop leaves
   * the value alone, which is what the null case below pins.
   */
  const WITH_SUCCESS = {
    attempts_success: 63,
    success_rate_pct: 26.25,
  };

  it('carries attempts_success and success_rate_pct through enrichment', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody(WITH_SUCCESS),
    });

    const app = await buildApp();
    const body = await getStats(app);

    expect(body['attempts_success']).toBe(63);
    expect(body['success_rate_pct']).toBe(26.25);
    await app.close();
  });

  it('keeps success_rate_pct NULL rather than coercing it to 0', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({ attempts_success: 0, success_rate_pct: null }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    // `toBeNull`, not a falsy check: `0` is falsy too and is the wrong answer.
    expect(body['success_rate_pct']).toBeNull();
    expect(body['success_rate_pct']).not.toBe(0);
    // And the count beside it stays a real 0 — that one IS a measurement.
    expect(body['attempts_success']).toBe(0);
    await app.close();
  });

  it('is byte-identical to the internal handler’s body once agent_name is stripped', async () => {
    // The generic property, restated over the real fields: the public API layer adds one key per
    // agent row and changes nothing else, so a diff here is a transform nobody
    // intended.
    const core = coreStatsBody(WITH_SUCCESS);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: core, headers: new Headers() });

    const app = await buildApp();
    const body = await getStats(app);

    expect(JSON.stringify(stripAgentNames(body))).toBe(JSON.stringify(core));
    await app.close();
  });

  it('the enricher itself passes them through, without the route in the way', async () => {
    // Called directly, so a future route-level transform cannot mask a regression
    // in the module every agency stats surface goes through.
    const core = coreStatsBody({ attempts_success: 7, success_rate_pct: null });
    const enriched = (await enrichAgencyCampaignStats(core, {
      tenantId: TENANT,
      status: 200,
    })) as Record<string, unknown>;

    expect(enriched['attempts_success']).toBe(7);
    expect(enriched['success_rate_pct']).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the OPTIONAL stats addition passes through untouched', () => {
  /**
   * The internal handler may add `attempts_retried` (a count) to its campaign-stats payload.
   * The public API layer produces it, defaults it and reads it nowhere, and — the part worth
   * stating — **tolerating its ABSENCE is the correct behaviour, not a
   * degradation**: an older internal handler simply does not serve the key, there is nothing
   * for the public API layer to fill in and no default that would be true.
   *
   * This is the block above, extended, and it exists for the same
   * reason: the code needed no change because `enrichAgencyCampaignStats` is a
   * spread rather than a reconstruction, and that is exactly the property a
   * "let's declare the response shape" refactor deletes. Naming the real field
   * makes the failure point at the real field instead of at a placeholder key.
   *
   * ── `agents_peak` is NOT asserted here, because the internal handler does not serve it ─────
   * A nullable `agents_peak` gauge was specified beside this count and
   * dropped before the internal handler implemented it: `grep -rn agents_peak` over the internal handler's
   * `src/` and `test/` returns nothing, and there is no column behind it. These
   * cases used to assert its pass-through, which proved only that a spread
   * spreads — the "field this repo has never heard of" case above already proves
   * that, without implying the field exists — while keeping
   * `AgencyCampaignStatsAdditions` reading as though the console could expect it.
   * The `null`-not-`0` rule it carried is pinned on fields the internal handler really serves:
   * `success_rate_pct` in the block above, `abandonment_rate_24h_pct` on the
   * stall fixture.
   */
  const WITH_ADDITION: AgencyCampaignStatsAdditions = { attempts_retried: 148 };

  it('carries attempts_retried through enrichment', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({ ...WITH_ADDITION }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    expect(body['attempts_retried']).toBe(148);
    await app.close();
  });

  it('keeps a real 0 as a measurement rather than dropping the key', async () => {
    // `attempts_retried` is a COUNT, so `0` means "nothing was redialled" and is
    // an answer. Dropping it (a falsy-value filter anywhere on this hop) would
    // make "we retried nobody" indistinguishable from "this internal handler does not
    // measure retries" — which is the one distinction the optionality carries.
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({ attempts_retried: 0 }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    expect(body['attempts_retried']).toBe(0);
    expect(Object.keys(body)).toContain('attempts_retried');
    await app.close();
  });

  it('is byte-identical to the internal handler\u2019s body once agent_name is stripped', async () => {
    const core = coreStatsBody({ ...WITH_ADDITION });
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: core, headers: new Headers() });

    const app = await buildApp();
    const body = await getStats(app);

    expect(JSON.stringify(stripAgentNames(body))).toBe(JSON.stringify(core));
    await app.close();
  });

  it('tolerates it being absent — an older internal handler ships no such key', async () => {
    // The base fixture carries it not at all, so this is the "older internal handler" shape.
    // The public API layer must not manufacture the key: `attempts_retried: 0` invented here
    // would claim "nobody was redialled" on an internal handler that has no opinion.
    const app = await buildApp();
    const body = await getStats(app);

    expect(Object.keys(body)).not.toContain('attempts_retried');
    await app.close();
  });

  it('does NOT manufacture the field the internal handler dropped', async () => {
    // The contract half of the removal above, asserted from the response rather
    // than from the type: the public API layer invents no `agents_peak`, so a console that
    // learned about it from a stale docstring gets no key to render, not a
    // fabricated `null` reading as "measured nothing".
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: coreStatsBody({ ...WITH_ADDITION }),
    });

    const app = await buildApp();
    const body = await getStats(app);

    expect(Object.keys(body)).not.toContain('agents_peak');
    await app.close();
  });

  it('the enricher itself passes it through, without the route in the way', async () => {
    // Called directly, so a future route-level transform cannot mask a regression
    // in the module every agency stats surface goes through.
    const core = coreStatsBody({ attempts_retried: 12 });
    const enriched = (await enrichAgencyCampaignStats(core, {
      tenantId: TENANT,
      status: 200,
    })) as Record<string, unknown>;

    expect(enriched['attempts_retried']).toBe(12);
    expect(Object.keys(enriched)).not.toContain('agents_peak');
  });
});
