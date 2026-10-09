import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * Exit gate: **a route-table test enumerated from the router covers
 * every console and super-admin path.**
 *
 * The route table is the real app's (`buildApp`, super-admin
 * tree registered), enumerated from Fastify's own `onRoute` hook — never by grep. The
 * console's paths come from `test/fixtures/console-paths.json`: every HTTP and WebSocket
 * call the console makes from `src/api/*` and `src/config.ts`, each classified
 * `served` or `not_served` with a reason (decision B16: the console's paths are the
 * contract).
 *
 * Four properties, each a way the merge could silently break the console (plus: every endpoint
 * the super-admin UI lists in `saRoutes.ts` is registered):
 *  1. every `served` console path is registered, at the console's path and method;
 *  2. no `not_served` console path is registered (the classification is honest);
 *  3. every registered route is accounted for — a console path, or a named server-only
 *     surface — so nothing ships reachable that nobody decided to expose;
 *  4. the internal handler modules are not on the table (they run behind `callCore` only).
 */

vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
});

import { buildApp } from '../../../src/app.js';
// The super-admin UI lists every endpoint it calls; pure data, no imports.
import { SA_ROUTES } from '../../../../super-admin/src/api/saRoutes.js';

interface ConsolePath {
  method: string;
  path: string;
  /** Repository-relative file that makes the call; absent for a not_served path no UI calls. */
  source?: string;
  status: 'served' | 'not_served';
  reason: string;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/console-paths.json', import.meta.url)), 'utf8'),
) as { _source: string; paths: ConsolePath[] };

/**
 * Served console paths whose routes are not registered yet. Each one is a
 * known, dated gap — not a classification. Empty this set as they land; a path left here
 * after it is served fails the "pending is really pending" case below.
 */
const PENDING: ReadonlyMap<string, string> = new Map([
  // Empty: the runtime routes have landed.
]);

/**
 * Registered routes that are deliberately NOT console calls. Each names why it exists.
 * The super-admin console is a separate UI over the platform routes, so its
 * super-admin shapes are here rather than in the console inventory.
 */
const SERVER_ONLY: ReadonlyMap<string, string> = new Map([
  ['GET /healthz', 'liveness probe'],
  ['GET /readyz', 'readiness probe'],
  ['POST /api/v1/webhooks/voicelink/webrtc-status/:_', 'VoiceLink bridge webhook (carrier-facing)'],
  ['WS /api/v1/webrtc-call/:_/pstn-stream', 'VoiceLink PSTN media leg (carrier-facing WS)'],
  ['GET /api/v1/webrtc-recordings/:_', 'signed recording playback (the HMAC token is the credential)'],
  ['GET /super-admin/usage', 'super-admin usage counts'],
  ['GET /super-admin/tenants/:_/accounts/:_/settings', 'per-account settings'],
  ['PUT /super-admin/tenants/:_/accounts/:_/settings', 'per-account settings'],
  ['PUT /super-admin/tenants/:_/memberships/:_/role', 'membership role change (decision Q3d)'],
  ['DELETE /super-admin/tenants/:_/memberships/:_', 'membership revoke (decision Q3d)'],
  ['GET /super-admin/feature-flags/:_', 'per-flag detail (super-admin-feature-flags.routes.ts)'],
  // The console's old `/proxy/feature-flags` path is not served. The flag map stays at
  // `GET /feature-flags`, and the console calls it there; the old path is `not_served` in the fixture.
  ['GET /feature-flags', 'client flag map at its agency path (the console calls it here)'],
]);

/** Fastify param names differ between files; the table compares shapes. */
const shape = (path: string): string =>
  (path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_').replace(/\/$/, '') || '/');
const keyOf = (method: string, path: string): string => `${method} ${shape(path)}`;

let app: FastifyInstance;
const registered = new Map<string, { websocket: boolean }>();

beforeAll(async () => {
  app = await buildApp({
    ctx: null,
    onRoute: (r: RouteOptions) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        const ws = (r as { websocket?: boolean }).websocket === true;
        registered.set(keyOf(ws ? 'WS' : m, r.url), { websocket: ws });
        // A websocket route is also a GET at the router.
        if (ws) registered.set(keyOf('GET', r.url), { websocket: true });
      }
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('the console path inventory', () => {
  it('is the fixture this test is about, with one entry per (method, path)', () => {
    expect(FIXTURE._source).toMatch(/src\/api/);
    const keys = FIXTURE.paths.map((p) => keyOf(p.method, p.path));
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of FIXTURE.paths) {
      expect(['served', 'not_served'], `${p.method} ${p.path}`).toContain(p.status);
      expect(p.reason.length, `${p.method} ${p.path} needs a reason`).toBeGreaterThan(0);
      if (p.status === 'served') expect(p.source, `${p.method} ${p.path} needs the file that calls it`).toBeDefined();
      if (p.source !== undefined) {
        expect(p.source, `${p.method} ${p.path}`).toMatch(/^apps\/(console|super-admin)\/src\//);
        expect(existsSync(join(REPO_ROOT, p.source)), `${p.method} ${p.path}: ${p.source} does not exist`).toBe(true);
      }
    }
  });

  it('registers EVERY served console path, at the console path and method', () => {
    const missing = FIXTURE.paths
      .filter((p) => p.status === 'served')
      .map((p) => keyOf(p.method, p.path))
      .filter((k) => !registered.has(k) && !PENDING.has(k));
    expect(missing).toEqual([]);
  });

  it('registers NO path the inventory says is not served', () => {
    const leaked = FIXTURE.paths
      .filter((p) => p.status === 'not_served')
      .map((p) => keyOf(p.method, p.path))
      .filter((k) => registered.has(k));
    expect(leaked).toEqual([]);
  });

  it('pending is really pending: each pending path is a served console path not yet registered', () => {
    const served = new Set(FIXTURE.paths.filter((p) => p.status === 'served').map((p) => keyOf(p.method, p.path)));
    for (const k of PENDING.keys()) {
      expect(served.has(k), `${k} is not a served console path`).toBe(true);
      expect(registered.has(k), `${k} is registered now — remove it from PENDING`).toBe(false);
    }
  });
});

describe('the route table', () => {
  it('accounts for every registered route: a console path or a named server-only surface', () => {
    const console = new Set(FIXTURE.paths.filter((p) => p.status === 'served').map((p) => keyOf(p.method, p.path)));
    const unaccounted = [...registered.keys()].filter((k) => {
      if (console.has(k) || SERVER_ONLY.has(k)) return false;
      // A websocket route's GET twin is accounted for by its WS entry.
      const [method, path] = k.split(' ') as [string, string];
      const wsKey = `WS ${path}`;
      return !(method === 'GET' && registered.get(k)?.websocket && (console.has(wsKey) || SERVER_ONLY.has(wsKey)));
    });
    expect(unaccounted).toEqual([]);
  });

  it('every server-only entry is registered (the list cannot rot)', () => {
    for (const k of SERVER_ONLY.keys()) expect(registered.has(k), k).toBe(true);
  });

  it("never exposes the internal handler modules: they run behind callCore only (decision B16)", () => {
    const core = [...registered.keys()].filter((k) =>
      /^\S+ \/api\/v1\/agency(-campaigns|-agents)?(\/|$)/.test(k) || /^\S+ \/internal(\/|$)/.test(k));
    expect(core).toEqual([]);
  });

  it("registers every endpoint the super-admin UI (`apps/super-admin/src/api/saRoutes.ts`) calls", () => {
    expect(SA_ROUTES.length).toBeGreaterThan(20);
    const missing = SA_ROUTES.map((r) => keyOf(r.method, r.path)).filter((k) => !registered.has(k));
    expect(missing).toEqual([]);
  });

  it('serves the agency API at the console prefixes only', () => {
    const agency = [...registered.keys()].filter((k) => /^\S+ \/(proxy\/agency|dnc)(\/|$)/.test(k));
    expect(agency.length).toBeGreaterThan(40);
  });
});
