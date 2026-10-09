import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { callCore, getCoreHandlers, setCoreHandlers } from '../../../src/api/core-dispatch.js';
import { buildCoreHandlers } from '../../../src/api/core-handlers.js';

/**
 * `callCore`, the in-process hop from the public API layer to the internal handler instance
 * (decision B16: tenancy comes from the tenant-context only, never client headers).
 *
 * 1. **Static resolution.** Every internal path a public-API handler hands `callCore` is read
 *    from the source text with the TypeScript parser (every file under `src/` that imports
 *    `core-dispatch`), and each must resolve to a route the private internal handler instance
 *    registers — enumerated from that instance's own `onRoute` hook. A typo, a renamed route
 *    or a path that never existed would otherwise be a 404 at run time that every mocked unit
 *    suite stays green on. The reverse is checked too: an internal handler no call site
 *    reaches is listed with its reason, so dead surface is a decision.
 * 2. **Tenancy.** `callCore` writes the internal tenant/account headers from its typed
 *    arguments (which every call site fills from `request.tenantId` / `request.accountId`,
 *    i.e. the tenant-context), AFTER any extra headers — so nothing a caller forwards can name
 *    a different tenant to the internal handler. The end-to-end half (a browser sending the
 *    internal headers or another tenant's id through the real app) is
 *    `test/integration/api/agency-tenant-isolation.test.ts`.
 * 3. The transport rules `callCore` keeps (query encoding, body gate, raw/text bodies, the
 *    traversal refusal, the wiring-defect throw).
 */

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
const SAMPLE_ID = '00000000-0000-4000-8000-0000000000aa';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

interface CallSite { file: string; line: number; method: string; path: string }

/** Every `{ method?, path: '/agency…' }` object literal in a callCore-importing file. */
function extractCallSites(): { sites: CallSite[]; dynamic: string[]; callers: string[] } {
  const sites: CallSite[] = [];
  const dynamic: string[] = [];
  const callers: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('core-dispatch.ts') || !/from '\.\.?\/(?:\.\.\/)*(?:api\/)?core-dispatch\.js'/.test(text)) continue;
    const rel = relative(SRC, file);
    callers.push(rel);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const literalText = (e: ts.Expression): string | null => {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
      if (ts.isTemplateExpression(e)) {
        return e.head.text + e.templateSpans.map((s) => SAMPLE_ID + s.literal.text).join('');
      }
      return null;
    };
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map<string, ts.Expression>();
        for (const p of node.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) props.set(p.name.text, p.initializer);
        }
        const pathExpr = props.get('path');
        if (pathExpr) {
          const path = literalText(pathExpr);
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          if (path !== null && path.startsWith('/agency')) {
            const m = props.get('method');
            sites.push({ file: rel, line, method: m && literalText(m) ? literalText(m)! : 'GET', path });
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'callCore') {
        const arg = node.arguments[0];
        const pathProp = arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'path')
          : undefined;
        const init = pathProp && ts.isPropertyAssignment(pathProp) ? pathProp.initializer : undefined;
        if (!init || literalText(init) === null) {
          dynamic.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${init ? init.getText(sf) : '<no path>'}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { sites, dynamic, callers };
}

/**
 * `callCore` calls whose path is not a literal at the call site, each with where its literals
 * come from (they are object literals elsewhere in the same file, so the extraction above
 * still sees them).
 */
const DYNAMIC_CALL_SITES: ReadonlyMap<string, string> = new Map([
  ['api/routes/proxy-agency-campaigns.routes.ts params.path',
    "the spine CSV export's page loop; its two callers pass literal `/agency-campaigns/${id}/attempts` and `/contacts` objects"],
]);

/** Internal handlers no public-API call site reaches, each with why. */
const UNREACHED_CORE_ROUTES: ReadonlyMap<string, string> = new Map([
  ['GET /api/v1/agency-campaigns/:_/attempts/:_/recording-url',
    "the internal handler's signed-URL minter; no public API route forwards to it, and the console plays through `/attempts/:attemptId/recording`"],
]);

const shape = (url: string) => url.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_').replace(/\/$/, '');
const toRegex = (url: string) => new RegExp(`^${url.replace(/\/$/, '').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+')}$`);

let core: FastifyInstance;
const coreRoutes: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  core = await buildCoreHandlers({
    campaigns: {
      runtime: {
        dnc: { appliedVersion: async () => null },
        stations: { connectedBySession: async () => new Map<string, boolean>() },
      },
      callManager: {
        accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'unavailable' as const }) },
      },
    },
    // Registration reads nothing from the runtime; only the table is under test here.
    agency: { runtime: {} as never },
    onRoute: (r: RouteOptions) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m !== 'HEAD' && m !== 'OPTIONS') coreRoutes.push({ method: m, url: r.url });
      }
    },
  });
});

afterAll(async () => {
  await core.close();
});

describe('callCore — static resolution against the private internal handler instance', () => {
  const { sites, dynamic, callers } = extractCallSites();

  it('finds the public-API handler modules and their internal paths (the extraction is not vacuous)', () => {
    expect(callers.sort()).toEqual([
      'api/agency.plugin.ts', // installs the instance (`setCoreHandlers`); calls nothing
      'api/routes/proxy-agency-agent.routes.ts',
      'api/routes/proxy-agency-calls.routes.ts',
      'api/routes/proxy-agency-campaigns.routes.ts',
      'api/routes/proxy-agency-performance.routes.ts',
      'api/routes/proxy-agency-staffing.routes.ts',
    ]);
    expect(sites.length).toBeGreaterThanOrEqual(30);
    expect(coreRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it('every literal internal path a public-API handler sends resolves to a registered internal route', () => {
    const unresolved = sites
      .filter((s) => !coreRoutes.some((r) => r.method === s.method && toRegex(r.url).test(`/api/v1${s.path.split('?')[0]}`)))
      .map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`);
    expect(unresolved).toEqual([]);
  });

  it('every non-literal call site is a known one, with where its literals come from', () => {
    const keys = dynamic.map((d) => d.replace(/:\d+ /, ' '));
    expect(keys.sort()).toEqual([...DYNAMIC_CALL_SITES.keys()].sort());
  });

  it('every internal route is reached by a call site, or listed as unreached with its reason', () => {
    const reached = (r: { method: string; url: string }) =>
      sites.some((s) => s.method === r.method && toRegex(r.url).test(`/api/v1${s.path.split('?')[0]}`));
    const unreached = coreRoutes.filter((r) => !reached(r)).map((r) => `${r.method} ${shape(r.url)}`);
    expect(unreached.sort()).toEqual([...UNREACHED_CORE_ROUTES.keys()].sort());
  });
});

describe('callCore — tenancy and transport', () => {
  let stub: FastifyInstance;
  let seen: { headers: Record<string, unknown>; url: string; body: unknown } | null;

  beforeAll(async () => {
    stub = Fastify({ logger: false });
    stub.all('/api/v1/*', async (request, reply) => {
      seen = { headers: request.headers, url: request.url, body: request.body ?? null };
      if (request.url.startsWith('/api/v1/text')) return reply.type('text/plain').send('plain words');
      return reply.code(207).send({ ok: true, at: new Date('2026-01-02T03:04:05.000Z') });
    });
    await stub.ready();
  });

  afterEach(() => {
    if (getCoreHandlers() === stub) setCoreHandlers(null);
    seen = null;
  });

  afterAll(async () => {
    await stub.close();
  });

  it('throws when the handler table was never built (a wiring defect, never a silent 404)', async () => {
    setCoreHandlers(null);
    await expect(callCore({ method: 'GET', path: '/agency-campaigns', tenantId: 't' })).rejects.toThrow(/not registered/);
  });

  it("writes the internal tenant/account headers from its arguments, after any extra header — a forwarded x-mgkvc-tenant cannot name another tenant", async () => {
    setCoreHandlers(stub);
    await callCore({
      method: 'GET',
      path: '/agency-campaigns',
      tenantId: 'tenant-from-context',
      accountId: 'account-from-context',
      headers: { 'x-mgkvc-tenant': 'tenant-B', 'x-mgkvc-account': 'account-B', range: 'bytes=0-1' },
    });
    expect(seen!.headers['x-mgkvc-tenant']).toBe('tenant-from-context');
    expect(seen!.headers['x-mgkvc-account']).toBe('account-from-context');
    expect(seen!.headers['range']).toBe('bytes=0-1');
  });

  it('does not let an extra header supply an account (or originator) the context lacks — the internal handler answers its own 400', async () => {
    setCoreHandlers(stub);
    await callCore({
      method: 'GET', path: '/agency-campaigns', tenantId: 't1',
      headers: { 'X-Mgkvc-Account': 'account-B', 'x-mgkvc-originator': 'spoofed' },
    });
    expect(seen!.headers['x-mgkvc-tenant']).toBe('t1');
    expect(seen!.headers['x-mgkvc-account']).toBeUndefined();
    expect(seen!.headers['x-mgkvc-originator']).toBeUndefined();
  });

  it("encodes the query with URLSearchParams and keeps JSON round-tripping (a Date arrives as its ISO string)", async () => {
    setCoreHandlers(stub);
    const res = await callCore({ method: 'GET', path: '/agency-campaigns', tenantId: 't', query: { a: '1', b: 'x y,z' } });
    expect(seen!.url).toBe('/api/v1/agency-campaigns?a=1&b=x+y%2Cz');
    expect(res.status).toBe(207);
    expect(res.body).toEqual({ ok: true, at: '2026-01-02T03:04:05.000Z' });
  });

  it('sends a body only for POST/PUT/PATCH and only when truthy', async () => {
    setCoreHandlers(stub);
    await callCore({ method: 'POST', path: '/agency-campaigns', tenantId: 't', body: { name: 'n' } });
    expect(seen!.body).toEqual({ name: 'n' });
    await callCore({ method: 'DELETE', path: '/agency-campaigns/x', tenantId: 't', body: { name: 'n' } });
    expect(seen!.body).toBeNull();
    await callCore({ method: 'POST', path: '/agency-campaigns', tenantId: 't', body: undefined });
    expect(seen!.body).toBeNull();
  });

  it('returns a Buffer for rawResponse and text for a non-JSON body', async () => {
    setCoreHandlers(stub);
    const raw = await callCore({ method: 'GET', path: '/agency-campaigns', tenantId: 't', rawResponse: true });
    expect(Buffer.isBuffer(raw.body)).toBe(true);
    const text = await callCore({ method: 'GET', path: '/text', tenantId: 't' });
    expect(text.body).toBe('plain words');
  });

  it("refuses a traversal path with the exact 400, without reaching the internal handler", async () => {
    setCoreHandlers(stub);
    const res = await callCore({ method: 'GET', path: '/agency-campaigns/../internal', tenantId: 't' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request', message: 'Invalid path: traversal segments are not allowed' });
    expect(seen).toBeNull();
  });
});
