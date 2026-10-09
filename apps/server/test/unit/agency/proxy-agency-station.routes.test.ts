import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';

/*
 * The station route is collapsed in-process: after its two refusals (no token -> 4401,
 * path-escaping id -> 1008) the console's socket is handed to the dialer runtime's
 * `handleStationSocket` (`src/agency/station-socket.ts`). There is no upstream socket, no
 * relay and no close-code translation, so `handleStationSocket` is mocked here as the
 * stand-in for the station handler.
 */

const mocks = vi.hoisted(() => ({
  // A SHARED logger, not a fresh one per `createChildLogger` call: the close
  // accounting this proxy performs (`cascade`, `observedCode`, `sentCode`,
  // `laundered`) exists to be read out of these lines, so the tests have to be
  // able to read them too. A per-call mock is unreachable from here.
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // The station handler the route hands the socket to, and the
  // runtime it is handed with (null models an app built without a context).
  handleStationSocket: vi.fn(async () => {}),
  runtime: { sentinel: 'agency-runtime' } as unknown as AgencyRuntime | null,
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => mocks.log,
}));
vi.mock('../../../src/agency/station-socket.js', () => ({
  handleStationSocket: mocks.handleStationSocket,
}));

import {
  proxyAgencyStationRoutes,
  rewriteStationWsUrl,
  STATION_CLOSE_CODES,
} from '../../../src/api/routes/proxy-agency-station.routes.js';
import {
  startProxyApp,
  connectClient,
  waitFor,
  type HarnessApp,
} from './ws-harness.js';

const PREFIX = '/proxy/agency/station';
const SESSION = '11111111-2222-3333-4444-555555555555';

/** The route takes the runtime getter. */
const RUNTIME = mocks.runtime;
const stationRoutes = (app: FastifyInstance) =>
  proxyAgencyStationRoutes(app, { getRuntime: () => mocks.runtime });

describe('rewriteStationWsUrl', () => {
  it('maps the internal absolute URL onto the proxy prefix, preserving the token', () => {
    expect(
      rewriteStationWsUrl(`wss://dialer-host:3000/api/v1/agency/station/${SESSION}?token=secret`),
    ).toBe(`/proxy/agency/station/${SESSION}?token=secret`);
  });

  it('handles an already-relative path', () => {
    expect(rewriteStationWsUrl(`/api/v1/agency/station/${SESSION}?token=x`)).toBe(
      `/proxy/agency/station/${SESSION}?token=x`,
    );
  });

  it('preserves a multi-parameter query string unchanged', () => {
    expect(
      rewriteStationWsUrl(`wss://c/api/v1/agency/station/${SESSION}?token=x&v=2`),
    ).toBe(`/proxy/agency/station/${SESSION}?token=x&v=2`);
  });

  it('falls back to the original URL on an unexpected shape', () => {
    // Degrading to "client talks to the internal address directly" beats minting a proxy path
    // that is guaranteed to 404.
    const odd = 'wss://dialer-host/some/other/path?token=x';
    expect(rewriteStationWsUrl(odd)).toBe(odd);
  });
});


describe('station WebSocket proxy', () => {
  let proxy: HarnessApp;

  beforeEach(async () => {
    mocks.log.info.mockClear();
    mocks.log.warn.mockClear();
    mocks.log.error.mockClear();
    mocks.handleStationSocket.mockClear();
    mocks.runtime = RUNTIME;
    proxy = await startProxyApp(stationRoutes, PREFIX);
  });

  afterEach(async () => {
    await proxy.close();
  });

  it('refuses an upgrade with no token, without contacting the station handler', async () => {
    // An 8-hour socket that anyone can attach to is a standing invitation to
    // join someone else's dialing session. Failing before the upstream connect
    // also means a token-less flood costs nothing upstream.
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}`);
    const closed = await client.waitForClose();

    expect(closed.code).toBe(STATION_CLOSE_CODES.MISSING_TOKEN);
    expect(mocks.handleStationSocket).not.toHaveBeenCalled();
  });

  it('forwards the session id and token to the station handler on the upgrade', async () => {
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}?token=sec%2Fret`);
    // The socket is handed to `handleStationSocket(socket, sessionId, token, runtime)`.
    await waitFor(() => mocks.handleStationSocket.mock.calls.length >= 1, 'station handler');

    const [socket, sessionId, token, runtime] = mocks.handleStationSocket.mock.calls[0]! as unknown as [
      { send: unknown }, string, string, unknown,
    ];
    expect(typeof socket.send).toBe('function');
    expect(sessionId).toBe(SESSION);
    // Round-trips a token containing a URL-significant character.
    expect(token).toBe('sec/ret');
    expect(runtime).toBe(RUNTIME);
    client.close();
  });

  // The refusal for "nothing to hand the socket to".
  it('closes 1011 when the app has no agency runtime', async () => {
    mocks.runtime = null;
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}?token=t`);
    const closed = await client.waitForClose();

    expect(closed.code).toBe(STATION_CLOSE_CODES.RUNTIME_UNAVAILABLE);
    expect(mocks.handleStationSocket).not.toHaveBeenCalled();
  });
});

describe('no RBAC here — verdict recorded, not left for the next reader to re-derive', () => {
  /**
   * ── The question this block answers ─────────────────────────────────────────────
   * `proxy-agency-agent.routes.ts` and `proxy-agency-campaigns.routes.ts` both
   * carry `requirePermission(...)` on every route (see
   * `proxy-agency-route-table.test.ts`'s "every agent action route carries its
   * RBAC permission" block). This file carries **zero**. Before this test, that
   * was indistinguishable from an omission — the same shape as a missing guard
   * on a route that needs one. It is not an omission: it is structurally the ONLY option.
   *
   * `proxyAgencyStationRoutes` registers no `sessionMiddleware`, no
   * `tenantContextMiddleware`, and no RBAC hook at all (contrast the other two
   * files' `app.addHook('preHandler', sessionMiddleware)` etc.) — a browser
   * `WebSocket` cannot set an `Authorization` header on the upgrade request, so
   * the server never gets a bearer token, never resolves `request.user` /
   * `request.membership`, and therefore has no role to run `requirePermission`
   * against on this path. Adding an RBAC preHandler here would not be a stronger
   * check; it would be `requirePermission` running against a session/membership
   * that were never populated, which throws or silently no-ops depending on how
   * it's mocked — worse than the honest absence.
   *
   * The real credential is the session-scoped, single-use, ~2-minute station
   * token. The route's whole contribution is refusing a *tokenless* upgrade
   * before handing the socket over — the station handler is the sole authority on
   * whether a *present* token is valid. That refusal is what
   * "refuses an upgrade with no token, without contacting the station handler" (above) already
   * exercises behaviourally; what was missing was a source-level assertion
   * pinning that the zero-RBAC shape is the intended one, so a future reader
   * finds a check rather than having to re-derive the reasoning from a comment —
   * a comment is not evidence about the file it sits in.
   */
  const source = readFileSync(
    new URL('../../../src/api/routes/proxy-agency-station.routes.ts', import.meta.url),
    'utf8',
  );

  it('imports no RBAC middleware', () => {
    expect(source).not.toMatch(/requirePermission/);
    expect(source).not.toMatch(/rbac\.middleware/);
  });

  it('registers no session or tenant-context preHandler — there is no request to attach one to', () => {
    // A WS upgrade has no Firebase bearer token to resolve, so these hooks
    // would have nothing to populate. Their absence is the same structural
    // fact as the RBAC absence above, not a second coincidence.
    expect(source).not.toMatch(/sessionMiddleware/);
    expect(source).not.toMatch(/tenantContextMiddleware/);
  });

  it('registers exactly one route in the whole file', () => {
    // If a second route ever gets added here, this reds and forces a fresh
    // decision about whether IT also needs no RBAC, rather than silently
    // inheriting this file's exemption by proximity.
    const registrations = source.match(/\bapp\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];
    expect(registrations).toHaveLength(1);
  });
});
