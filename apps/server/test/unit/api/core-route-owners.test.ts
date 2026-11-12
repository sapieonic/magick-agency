import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreHandlers } from '../../../src/api/core-handlers.js';
import {
  AGENCY_CORE_ROUTE_OWNERS,
  assertCoreRouteClassified,
  resolveCoreRoute,
} from '../../../src/api/core-owners.js';

/*
 * Which process each internal agency handler runs in once there are media workers
 * (`src/api/core-owners.ts`, docs/scaling.md §3.4). Pins:
 *  - the owner table and the internal instance's agency routes are the same set, both
 *    ways (enumerated from the instance's `onRoute`, never grepped), and an unclassified
 *    agency route fails registration;
 *  - a handler that touches the agency runtime is never `none` unless it is listed below
 *    with the reason its runtime use is process-independent;
 *  - resolution of a URL to its owner kind and id.
 */

/**
 * `none` handlers that use the runtime anyway, and why that is safe in any process: they
 * touch only Redis and Postgres through it, never the per-session in-process state
 * (dialer, wrap-up, breaks, soft phone's live call, the station map).
 */
const INBOUND_SINGLE_PROCESS = 'inbound callers are connected only in one process (IB8, docs/inbound.md §2): the connector, its calls and the agents it took live in the process that answers every inbound call, where a `none` handler runs; with media workers nobody is connected, so no call has an agent to finish';

const AWAY_RING_NO_STATION = 'the agent\'s own push devices (Postgres, the push sender) and the flag read; the opt-out and the removal end the device\'s `away_ring`, which is held with no station socket, so its end touches Redis and Postgres only (Mode B, IQ67)';

const NONE_WITH_RUNTIME: Record<string, string> = {
  'POST /sessions': 'the join: rehydrates the Redis lease, writes the row and mints a Redis token; no station is attached to any process yet',
  'POST /softphone/sessions': 'the soft-phone join: the same rehydrate and Redis token mint as the campaign join',
  'GET /inbound/calls/:id': INBOUND_SINGLE_PROCESS,
  'PATCH /inbound/calls/:id': INBOUND_SINGLE_PROCESS,
  'POST /inbound/calls/:id/hangup': INBOUND_SINGLE_PROCESS,
  'POST /inbound/calls/:id/disposition': INBOUND_SINGLE_PROCESS,
  'POST /inbound/calls/:id/dnc': INBOUND_SINGLE_PROCESS,
  'GET /inbound/queue': INBOUND_SINGLE_PROCESS,
  'GET /push-devices/:id': AWAY_RING_NO_STATION,
  'PUT /push-devices/:id': AWAY_RING_NO_STATION,
  'PATCH /push-devices/:id': AWAY_RING_NO_STATION,
  'DELETE /push-devices/:id': AWAY_RING_NO_STATION,
  'POST /push-devices/:id/test-ring': AWAY_RING_NO_STATION,
};

let core: FastifyInstance;
const agencyRoutes = new Set<string>();

beforeAll(async () => {
  core = await buildCoreHandlers({
    campaigns: {
      runtime: {
        dnc: { appliedVersion: async () => null },
        stations: { connectedBySession: async () => new Map<string, boolean>(), inboundCapabilityBySession: () => new Map<string, boolean>() },
      },
      callManager: {
        accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'unavailable' as const }) },
      },
    },
    agency: { runtime: {} as never },
    onRoute: (r: RouteOptions) => {
      if (!r.url.startsWith('/api/v1/agency/')) return;
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== 'HEAD' && m !== 'OPTIONS') agencyRoutes.add(`${m} ${r.url.slice('/api/v1/agency'.length)}`);
      }
    },
  });
});

afterAll(async () => { await core.close(); });

describe('internal route owners', () => {
  it('the owner table lists exactly the agency routes the internal instance registers', () => {
    expect(agencyRoutes.size).toBeGreaterThan(20);
    expect([...agencyRoutes].sort()).toEqual(Object.keys(AGENCY_CORE_ROUTE_OWNERS).sort());
  });

  it('an agency route missing from the table fails registration; other prefixes are not its business', () => {
    expect(() => assertCoreRouteClassified('POST', '/api/v1/agency/sessions/:id/brand-new')).toThrow(/no owner/);
    expect(() => assertCoreRouteClassified(['GET', 'HEAD'], '/api/v1/agency/softphone/settings')).not.toThrow();
    expect(() => assertCoreRouteClassified('GET', '/api/v1/agency-campaigns/:id')).not.toThrow();
  });

  it('a handler that uses the agency runtime is never `none` without a written reason', () => {
    const dir = resolve(__dirname, '../../../src/api/routes/agency');
    const registration = /\bsub\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g;
    const offenders: string[] = [];
    let seen = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      const hits = [...text.matchAll(registration)];
      hits.forEach((hit, i) => {
        seen++;
        const key = `${hit[1]!.toUpperCase()} ${hit[2]!}`;
        const chunk = text.slice(hit.index, hits[i + 1]?.index ?? text.length);
        const usesRuntime = /\bruntime\b/.test(chunk);
        const owner = AGENCY_CORE_ROUTE_OWNERS[key];
        expect(owner, `${file}: ${key} is in the owner table`).toBeDefined();
        if (usesRuntime && owner === 'none' && !NONE_WITH_RUNTIME[key]) offenders.push(`${file}: ${key}`);
      });
    }
    expect(seen).toBe(agencyRoutes.size);
    expect(offenders).toEqual([]);
    // And every reason still names a `none` route.
    for (const key of Object.keys(NONE_WITH_RUNTIME)) expect(AGENCY_CORE_ROUTE_OWNERS[key]).toBe('none');
  });
});

describe('resolveCoreRoute', () => {
  const S = '0b9f1c56-1d1e-4c5a-9a55-2a8a2b8f3c11';
  it('maps a URL to its owner kind and :id', () => {
    expect(resolveCoreRoute('POST', `/api/v1/agency/sessions/${S}/available`)).toEqual({ owner: 'session_param', id: S });
    expect(resolveCoreRoute('POST', `/api/v1/agency/attempts/${S}/disposition`)).toEqual({ owner: 'attempt_param', id: S });
    expect(resolveCoreRoute('post', `/api/v1/agency/softphone/calls/${S}/hangup?x=1`)).toEqual({ owner: 'manual_call_param', id: S });
    expect(resolveCoreRoute('GET', '/api/v1/agency/softphone/bootstrap?tenant=t')).toEqual({ owner: 'actor_session', id: null });
    expect(resolveCoreRoute('POST', '/api/v1/agency/softphone/calls')).toEqual({ owner: 'body_session', id: null });
    expect(resolveCoreRoute('POST', '/api/v1/agency/sessions')).toEqual({ owner: 'none', id: null });
    expect(resolveCoreRoute('HEAD', '/api/v1/agency/softphone/settings')).toEqual({ owner: 'none', id: null });
  });

  it('is `none` outside /api/v1/agency, and null for an agency URL no route serves', () => {
    expect(resolveCoreRoute('GET', `/api/v1/agency-campaigns/${S}/stats`)).toEqual({ owner: 'none', id: null });
    expect(resolveCoreRoute('GET', '/api/v1/agency-agents/stats')).toEqual({ owner: 'none', id: null });
    expect(resolveCoreRoute('DELETE', `/api/v1/agency/sessions/${S}`)).toBeNull();
    expect(resolveCoreRoute('POST', `/api/v1/agency/sessions/${S}/available/extra`)).toBeNull();
    expect(resolveCoreRoute('POST', '/api/v1/agency/sessions//available')).toBeNull();
  });

  it('decodes the id', () => {
    expect(resolveCoreRoute('POST', '/api/v1/agency/sessions/a%2Fb/leave')).toEqual({ owner: 'session_param', id: 'a/b' });
  });
});
