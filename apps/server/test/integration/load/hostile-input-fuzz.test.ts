import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ─── Hostile input, at volume, on every route the router holds ──────────────────
 *
 * Every route is enumerated from Fastify's own `onRoute` hook on the REAL app (real context,
 * super-admin routes on), never by grep. Each one is then sent a seeded battery of hostile
 * requests, authenticated as the caller that reaches its handler (a supervisor for the
 * console API, a super-admin for `/super-admin/*`) and anonymously:
 *
 *   - path params that are not ids: malformed UUIDs, `%00`, dot segments, a 190-char run,
 *     numbers, unicode, an id of the right shape that exists nowhere;
 *   - bodies of the wrong kind: wrong `content-type`s, invalid JSON, JSON scalars and arrays
 *     where an object belongs, `__proto__` / `constructor` keys, every field the wrong type,
 *     JSON nested 5 000 deep, strings of 100 000 characters;
 *   - query strings with repeated keys, negative and enormous numbers, bad dates;
 *   - a malformed `X-Tenant-Id` / `X-Account-Id`;
 *   - a body over the 10 MiB limit, on a seeded sample of the write routes.
 *
 * What it pins, for every one of those requests:
 *  1. **No 5xx.** Malformed input is the caller's error: a 4xx per the route's contract. A
 *     `22P02` (a non-UUID reaching a `uuid` cast) must never surface as a 500.
 *  2. **No internals in any body**: no stack frame, source path, SQL or driver text.
 *  3. An oversize body is a `413`, a non-JSON content type on a JSON route a `415`.
 * The seed is printed; `LOAD_SEED` replays a red run, `LOAD_SCALE` sends more variants.
 * Mutation-checked: disabling the `22P02 → 400` backstop (`agency-error-handler.ts`) reds
 * case 1 with ~250 masked 500s.
 *
 * Defects this suite found, all fixed beside it (reverting any of the first three reds case
 * 1, the fourth reds case 4): a NUL byte
 * in a path param reached Postgres as `22021` and answered 500 on every unvalidated
 * super-admin `:id` route (now the backstop's 400 too); `POST /auth/session` let a
 * Firebase-refused token throw (500, now 401); `callCore`'s `JSON.stringify` of a deeply
 * nested forwarded body overflowed the stack (500 on `POST /proxy/agency/campaigns`, now a
 * fixed 400); a cut-off multipart upload answered 500 (now 400, case 4). Case 5 is the one
 * left failing.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'load-fuzz-secret-0123456789abcdef';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
// No S3 in the suites: mocked at its module boundary, so an upload that parses is stored and a
// 5xx can only be the route's own.
vi.mock('../../../src/storage/s3.js', () => ({
  uploadFile: async () => undefined,
  getFile: async () => Buffer.from('Name,Mobile\nA,9876543210\n'),
  headFile: async () => ({ contentLength: 24 }),
  getFileStream: async () => { const { Readable } = await import('node:stream'); return { body: Readable.from([Buffer.from('Name,Mobile\nA,9876543210\n')]), contentLength: 24 }; },
}));

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { LightMyRequestResponse, RouteOptions } from 'fastify';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';
import { LOAD_SCALE, createRng, scaled } from '../../helpers/load-scale.js';
import {
  expectHealthy, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from './load-harness.js';

const rng = createRng();
const VARIANTS = scaled(6);

interface Route { method: string; url: string; websocket: boolean }
const routes: Route[] = [];
let loaded: LoadApp;
let floor: TenantFloor;
let superToken = '';
const audit = trackSuperAdminAuditWrites();
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[hostile-input-fuzz] seed=${rng.seed} variants=${VARIANTS}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: 10_000_000, webhookMax: 10_000_000, carrierMediaMax: 10_000_000 } }),
    onRoute: (r: RouteOptions) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        routes.push({ method: m, url: r.url, websocket: Boolean((r as { websocket?: boolean }).websocket) });
      }
    },
  });
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignStatus: 'running' }))[0]!;
  const admin = randomUUID();
  await getTestPool().query(
    `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, 'fuzz@load.example.com', 'x', 'Fuzz', 'active')`, [admin]);
  superToken = jwt.sign({ sub: admin, email: 'fuzz@load.example.com', type: 'super_admin' }, process.env['SUPER_ADMIN_JWT_SECRET']!, { expiresIn: '1h' });
}, 60_000);

afterAll(async () => {
  await audit.drain();
  audit.restore();
  await stopLoadApp(loaded);
});

// ── The hostile values ──────────────────────────────────────────────────────────

const BAD_IDS = [
  'not-a-uuid', '00000000-0000-0000-0000-00000000000g', '%00', '..', '%2E%2E', '123', '-1', '1e309',
  'ffffffff-ffff-ffff-ffff-ffffffffffff', "'; DROP TABLE users; --", 'a'.repeat(190), '%F0%9F%92%A9', 'null', 'undefined',
  '%20', randomUUID(),
];

function deep(depth: number): string {
  return `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
}

function junkValue(): unknown {
  return rng.pick<unknown>([
    null, true, -1, 1e308, -0, 'x'.repeat(100_000), '', [], [[[]]], {}, { $gt: '' }, '1970-01-01', 'not-a-date',
    '\u0000', '\ud800', randomUUID(), 'not-a-uuid', ['a', 1, null], { nested: { deeper: [1, { x: '\u0000' }] } },
  ]);
}

/** A JSON object whose every field is the wrong type, plus the keys a parser must refuse. */
function junkObject(): Record<string, unknown> {
  const keys = ['id', 'campaign_id', 'user_id', 'name', 'status', 'email', 'phone_e164', 'disposition_code', 'notes', 'reason',
    'callback_at', 'role', 'limit', 'from', 'to', 'scope', 'caller_ids', 'disposition_catalog', 'settings', 'value', 'id_token',
    'password', 'max_concurrent_calls', 's3_key', 'file_name', 'phone_column', 'session_id', 'mode', 'dry_run'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (rng.chance(0.6)) out[k] = junkValue();
  return out;
}

interface Variant { label: string; params: string; body?: string; contentType?: string; query?: string; tenant?: string }

function variantsFor(route: Route): Variant[] {
  const out: Variant[] = [];
  const hasParams = route.url.includes(':') || route.url.includes('*');
  const writes = route.method !== 'GET' && route.method !== 'DELETE';
  for (let i = 0; i < VARIANTS; i++) {
    const params = hasParams ? rng.pick(BAD_IDS) : '';
    out.push({ label: `bad param ${params}`, params });
    out.push({ label: 'bad query', params: hasParams ? rng.pick(BAD_IDS) : '', query: rng.pick([
      'limit=-1&limit=2', 'limit=99999999999999999999', 'from=not-a-date&to=2026-13-45', 'cursor=%00%ff', 'bucket=century',
      'campaign_id=not-a-uuid', 'campaign_id=a&campaign_id=b', `q=${'z'.repeat(5000)}`, 'state[]=x&state[$ne]=y', 'from=1e309',
    ]) });
    if (writes) {
      out.push({ label: 'junk object', params, body: JSON.stringify(junkObject()), contentType: 'application/json' });
      out.push({ label: 'json scalar', params, body: JSON.stringify(rng.pick<unknown>([null, 1, 'x', [], [junkObject()], true])), contentType: 'application/json' });
      out.push({ label: 'invalid json', params, body: rng.pick(['{', '{"a":', '{"a":1}}', '\u0000', '{"a":NaN}', "{'a':1}"]), contentType: 'application/json' });
      out.push({ label: 'proto keys', params, body: rng.pick(['{"__proto__":{"isAdmin":true}}', '{"constructor":{"prototype":{"x":1}}}']), contentType: 'application/json' });
      out.push({ label: 'deep json', params, body: deep(5_000), contentType: 'application/json' });
      const contentType = rng.pick(['application/xml', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']);
      // The upload route's headerless-part hang is pinned by case 5 (`it.fails`); kept out of
      // the sweep so the sweep keeps reporting everything else.
      const body = route.url === UPLOAD && contentType.startsWith('multipart/') ? '<a/>' : rng.pick(['<a/>', 'a=1&b=2', HEADERLESS_PART]);
      out.push({ label: 'wrong content type', params, body, contentType });
    }
    out.push({ label: 'malformed tenant header', params, tenant: rng.pick(['not-a-uuid', '', ' ', 'a'.repeat(300), '%00']) });
  }
  return out;
}

const UPLOAD = '/proxy/agency/ingest/upload';
/** One multipart part with NO headers, then a closing boundary not preceded by CRLF. */
const HEADERLESS_PART = '--x\r\n\r\n--x--';
/** A per-request bound: a request that never answers is a named failure, not a suite timeout. */
const ANSWER_WITHIN_MS = 15_000;

function urlOf(route: Route, param: string, query?: string): string {
  const path = route.url.replace(/:[A-Za-z_]+/g, () => param).replace(/\*$/, param);
  return query ? `${path}?${query}` : path;
}

function headersOf(route: Route, v: Variant, anonymous: boolean): Record<string, string> {
  const base: Record<string, string> = route.url.startsWith('/super-admin')
    ? { authorization: `Bearer ${superToken}`, 'x-forwarded-for': '10.250.0.1' }
    : headersFor(floor.supervisors[0]!, floor);
  if (anonymous) delete base['authorization'];
  if (v.tenant !== undefined) base['x-tenant-id'] = v.tenant;
  if (v.contentType) base['content-type'] = v.contentType;
  return base;
}

async function send(route: Route, v: Variant, anonymous: boolean): Promise<LightMyRequestResponse | 'HUNG'> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'HUNG'>((resolve) => { timer = setTimeout(() => resolve('HUNG'), ANSWER_WITHIN_MS); });
  try {
    return await Promise.race([app().inject({
      method: route.method as 'GET',
      url: urlOf(route, encodeURIComponentSafe(v.params), v.query),
      headers: headersOf(route, v, anonymous),
      ...(v.body !== undefined ? { payload: v.body } : {}),
    }), hung]);
  } finally {
    clearTimeout(timer);
  }
}

/** Params are sent as written when they are already percent-encoded, encoded otherwise. */
function encodeURIComponentSafe(p: string): string {
  return /%[0-9A-F]{2}/i.test(p) ? p : encodeURIComponent(p);
}

describe('hostile input at volume, every route from onRoute (integration, load)', () => {
  it('enumerates the real route table', () => {
    // The console API, the super-admin tree and the probes are all present.
    const keys = routes.map((r) => `${r.method} ${r.url}`);
    expect(keys).toEqual(expect.arrayContaining([
      'GET /healthz', 'POST /proxy/agency/sessions', 'POST /proxy/agency/attempts/:id/disposition', 'POST /super-admin/login',
    ]));
    expect(routes.length).toBeGreaterThan(100);
  });

  it('1–2. no hostile request on any route answers 5xx or leaks internals', async () => {
    const failures: string[] = [];
    let sent = 0;
    for (const route of routes) {
      if (route.websocket) continue; // the upgrade paths have their own suites (close codes, not statuses)
      const variants = variantsFor(route);
      const answers = await Promise.all(variants.flatMap((v) => [
        send(route, v, false).then((res) => ({ v, res, anonymous: false })),
        send(route, v, true).then((res) => ({ v, res, anonymous: true })),
      ]));
      for (const { v, res, anonymous } of answers) {
        sent++;
        if (res === 'HUNG') {
          failures.push(`${route.method} ${route.url} [${v.label}${anonymous ? ', anonymous' : ''}] → no answer within ${ANSWER_WITHIN_MS} ms`);
          continue;
        }
        const label = `${route.method} ${route.url} [${v.label}${anonymous ? ', anonymous' : ''}] → ${res.statusCode} ${res.body.slice(0, 160)}`;
        try {
          expectHealthy(res, label);
        } catch {
          failures.push(label);
        }
      }
    }
    console.log(`[hostile-input-fuzz] ${sent} hostile requests over ${routes.length} routes`);
    expect(failures).toEqual([]);
  }, 120_000 * LOAD_SCALE);

  it('3. an oversize body is a 413 and a non-JSON body on a JSON route a 415, on a sample of write routes', async () => {
    const writes = routes.filter((r) => !r.websocket && ['POST', 'PUT', 'PATCH'].includes(r.method)
      && !r.url.includes('/ingest/upload') && !r.url.startsWith('/api/v1/webhooks'));
    const sample = rng.shuffle(writes).slice(0, Math.min(writes.length, scaled(6)));
    const huge = JSON.stringify({ notes: 'x'.repeat(10 * 1024 * 1024 + 10) });
    // A fresh client address per request: the sweep above has spent the per-route buckets
    // (the invite routes' 20/min) of the supervisor's own address.
    let n = 0;
    const fresh = () => ({ ...headersFor(floor.supervisors[0]!, floor), 'x-forwarded-for': `10.251.${Math.floor(++n / 250)}.${(n % 250) + 1}` });
    for (const route of sample) {
      const big = await app().inject({ method: route.method as 'POST', url: urlOf(route, randomUUID()), headers: { ...fresh(), 'content-type': 'application/json' }, payload: huge });
      expectHealthy(big, `${route.url} oversize`);
      expect(big.statusCode, `${route.method} ${route.url} oversize`).toBe(413);
      const xml = await app().inject({ method: route.method as 'POST', url: urlOf(route, randomUUID()), headers: { ...fresh(), 'content-type': 'application/xml' }, payload: '<a/>' });
      expectHealthy(xml, `${route.url} xml`);
      expect(xml.statusCode, `${route.method} ${route.url} xml`).toBe(415);
    }
  }, 120_000);
  const upload = (body: string) => app().inject({
    method: 'POST', url: UPLOAD,
    headers: { ...headersFor(floor.supervisors[0]!, floor), 'content-type': 'multipart/form-data; boundary=x' }, payload: body,
  });

  it('4. a malformed roster upload is a 4xx, a well-formed one is stored', async () => {
    const part = '--x\r\nContent-Disposition: form-data; name="file"; filename="roster.csv"\r\nContent-Type: text/csv\r\n\r\nName,Mobile\r\nA,9876543210';
    for (const body of ['<a/>', 'a=1&b=2', '', '--x--', part /* cut off: no closing boundary */]) {
      const res = await upload(body);
      expectHealthy(res, `upload ${JSON.stringify(body.slice(0, 40))}`);
      expect(res.statusCode, `${JSON.stringify(body.slice(0, 40))}: ${res.body}`).toBe(400);
    }
    // This case found that a cut-off part answered a masked 500 (busboy's status-less
    // `Unexpected end of form`); fixed in the upload route. The control: complete, it is stored.
    const ok = await upload(`${part}\r\n--x--\r\n`);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().file_name).toBe('roster.csv');
  });

  /**
   * ── DEFECT: a headerless multipart part hangs the upload request forever ─────────
   *
   * `POST /proxy/agency/ingest/upload` with `multipart/form-data; boundary=x` and the body
   * `--x\r\n\r\n--x--` (one part with no headers, its closing boundary not preceded by
   * CRLF) never answers: `request.file()` neither yields a part nor ends, so the handler
   * awaits forever. Any member holding `agency.campaigns.write` can park requests (and
   * their sockets and parser state) on the server indefinitely with a 15-byte body. The
   * stall is inside `@fastify/multipart` / busboy (a skipped part at end of input never
   * finishes); a route-level fix needs a parse deadline that also tears the socket down,
   * which is a design choice beyond a local patch, so it is left failing.
   */
  it.fails('5. a headerless multipart part is answered, not left hanging', async () => {
    const res = await Promise.race([upload(HEADERLESS_PART), new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 5_000))]);
    expect(res).not.toBe('HUNG');
  });
});
