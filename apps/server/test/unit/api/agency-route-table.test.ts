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
const PENDING: ReadonlyMap<string, string> = new Map([]);

/**
 * Registered routes that are deliberately NOT console calls. Each names why it exists.
 * The super-admin console is a separate UI over the platform routes, so its
 * super-admin shapes are here rather than in the console inventory.
 */
const SERVER_ONLY: ReadonlyMap<string, string> = new Map([
  ['GET /healthz', 'liveness probe'],
  ['GET /readyz', 'readiness probe'],
  // The console's Overview/Performance tabs were its only caller; the Insights tab replaced them
  // (docs/insights.md, IN1). Kept: its types live in `contracts/src/agency/performance.ts`, beside
  // the agent's own record the mobile wire mirrors, and the insights rollup oracle cross-checks its
  // day trends against it (`insights-rollup-oracle.test.ts`).
  ['GET /proxy/agency/campaigns/:_/stats/series', 'campaign stats series (no console caller since the Insights tab)'],
  ['POST /api/v1/webhooks/voicelink/webrtc-status/:_', 'VoiceLink bridge webhook (carrier-facing)'],
  // The report renderer's signed callback (docs/reports.md RP13; the HMAC is the credential).
  ['POST /webhooks/reports/rendered', 'report renderer callback (HMAC-signed, no session)'],
  ['POST /api/v1/webhooks/plivo/webrtc-answer/:_', 'Plivo answer callback, replies XML (carrier-facing)'],
  ['POST /api/v1/webhooks/plivo/webrtc-status/:_', 'Plivo ring and hangup callback (carrier-facing)'],
  ['POST /api/v1/webhooks/plivo/webrtc-recording/:_', 'Plivo recording-ready callback (carrier-facing)'],
  // Inbound calls (docs/inbound.md §3.1): the credential's Plivo Application posts these.
  ['POST /api/v1/webhooks/plivo/inbound-answer/:_', 'Plivo inbound answer callback, replies XML (carrier-facing)'],
  ['POST /api/v1/webhooks/plivo/inbound-status/:_', 'Plivo inbound hangup callback (carrier-facing)'],
  ['POST /api/v1/webhooks/plivo/inbound-fallback', 'Plivo inbound fallback answer URL: fixed XML, no state (carrier-facing)'],
  ['WS /api/v1/webrtc-call/:_/pstn-stream', 'carrier PSTN media leg, VoiceLink and Plivo (carrier-facing WS)'],
  ['GET /api/v1/webrtc-recordings/:_', 'signed recording playback (the HMAC token is the credential)'],
  ['GET /super-admin/usage', 'super-admin usage counts'],
  ['GET /super-admin/tenants/:_/accounts/:_/settings', 'per-account settings'],
  ['PUT /super-admin/tenants/:_/accounts/:_/settings', 'per-account settings'],
  ['PUT /super-admin/tenants/:_/memberships/:_/role', 'membership role change (decision Q3d)'],
  ['DELETE /super-admin/tenants/:_/memberships/:_', 'membership revoke (decision Q3d)'],
  ['GET /super-admin/feature-flags/:_', 'per-flag detail (super-admin-feature-flags.routes.ts)'],
  // Per-tenant carrier credentials (decisions B18-B22; super-admin-telephony-credentials.routes.ts).
  // `POST …/:_/verify` is a console-path entry instead: the inventory already named it.
  ['GET /super-admin/telephony-credential-providers', 'carrier credential forms (BYOC, B20)'],
  ['GET /super-admin/telephony-credentials', 'carrier credential list (BYOC, B20)'],
  ['GET /super-admin/telephony-credentials/:_', 'carrier credential detail + usage (BYOC, B20)'],
  ['POST /super-admin/telephony-credentials', 'carrier credential create, verified with the carrier (BYOC, B20)'],
  ['PATCH /super-admin/telephony-credentials/:_', 'carrier credential rename (BYOC, B20)'],
  ['PUT /super-admin/telephony-credentials/:_/secret', 'carrier credential secret rotation (BYOC, B20)'],
  ['POST /super-admin/telephony-credentials/:_/disable', 'carrier credential disable (BYOC, B20)'],
  ['POST /super-admin/telephony-credentials/:_/enable', 'carrier credential enable (BYOC, B20)'],
  ['POST /super-admin/telephony-credentials/:_/revoke', 'carrier credential revoke (BYOC, B20)'],
  // The super-admin UI's "Sync numbers" action lands with the UI workstream (saRoutes.ts then lists it).
  ['POST /super-admin/telephony-credentials/:_/sync-numbers', 'carrier account number sync (BYOC, B18; audited)'],
  // Read by the console's campaign builder once its carrier choice lands (B18).
  ['GET /proxy/agency/carriers', 'carrier accounts a campaign may dial on (BYOC, B18)'],
  // The console's old `/proxy/feature-flags` path is not served. The flag map stays at
  // `GET /feature-flags`, and the console calls it there; the old path is `not_served` in the fixture.
  ['GET /feature-flags', 'client flag map at its agency path (the console calls it here)'],
  // Public, called by the mobile app before sign-in (`client-config.routes.ts`); the console
  // does not call it.
  ['GET /client-config', 'mobile app version gate (public, platform config)'],
  // Mode B: the agent mobile app's push devices (`proxy-agency-push-devices.routes.ts`); the
  // console has no push device to register.
  ['GET /proxy/agency/push-devices/:_', 'mobile app push device status (Mode B)'],
  ['PUT /proxy/agency/push-devices/:_', 'mobile app push device register (Mode B)'],
  ['PATCH /proxy/agency/push-devices/:_', 'mobile app ring opt-in and opt-out, the Me toggle (Mode B)'],
  ['DELETE /proxy/agency/push-devices/:_', 'mobile app push device removal on sign-out (Mode B)'],
  ['POST /proxy/agency/push-devices/:_/test-ring', 'mobile app "Send a test ring" (Mode B)'],
  // Mode B: the ring of an away agent's phone (`proxy-agency-inbound-ring.routes.ts`): native
  // Android posts answering and decline at the tap (token only), the app's Dart posts accept.
  ['POST /proxy/agency/inbound/calls/:_/ring/answering', 'mobile app native ring Answer (Mode B, token only)'],
  ['POST /proxy/agency/inbound/calls/:_/ring/decline', 'mobile app native ring Decline (Mode B, token only)'],
  ['POST /proxy/agency/inbound/calls/:_/ring/accept', 'mobile app takes a ring it answered (Mode B)'],
  ['POST /client-config/uplink-probe', 'mobile pre-flight upload-speed probe (authenticated body sink, 64 KiB, 6/min per user)'],
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
