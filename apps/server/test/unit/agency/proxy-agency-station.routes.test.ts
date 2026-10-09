import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AgencyRuntime } from '../../../src/agency/runtime.js';

/*
 * PORT NOTE (magick-agency, Phase 8): master `test/unit/agency/proxy-agency-station.routes.test.ts`
 * @a1f0756a. Source 58 cases → ported 10 (9 kept or modified + 1 new). Source count: 37 `it`
 * literals, one more inside a `for…of` over a 19-row table, and one `it.each` of 2 rows.
 *
 * What changed under it: master's route opened a SECOND socket to core and relayed frames and
 * close codes between the two legs. Here the route is collapsed in-process (its own PORT NOTE):
 * after master's two refusals (no token → 4401, path-escaping id → 1008) the console's socket is
 * handed to core's `handleStationSocket` (`src/agency/station-socket.ts`) — no upstream socket,
 * no relay, no close-code translation.
 *
 * Harness changes, and only these:
 *  - `handleStationSocket` is mocked (`../../../src/agency/station-socket.js`); it is the
 *    in-process stand-in for "core" that `ws-harness.ts`'s deleted `FakeCore` used to be;
 *  - the route is registered with `{ getRuntime }` through a one-line wrapper, since
 *    `proxyAgencyStationRoutes` now takes the runtime getter; the runtime is a sentinel object;
 *  - the `config` mock and its mutable `coreUrl` holder are gone (the route reads no
 *    `config.coreService.url`), as are `startStallingCore` and the `loggedFields` /
 *    `closeLines` helpers (only the deleted relay cases read them);
 *  - the logger mock is a partial over `@magick-agency/observability`, keeping master's single
 *    shared logger;
 *  - `startFakeCore` is gone from the imports (deleted from `ws-harness.ts`).
 *
 * DELETED (49), each because the thing it tests no longer exists with the second leg:
 *  - `isSendableCloseCode` (20: the 19-row table, "agrees with ws about every code…"),
 *    `truncateCloseReason` (6: "leaves a reason inside the budget untouched", "leaves a reason
 *    at exactly the budget untouched", "measures BYTES, not characters…", "drops a whole emoji
 *    rather than splitting its surrogate pair", "drops trailing emoji whole when several
 *    straddle the budget", "keeps the code marker and trims the peer's tail…") and
 *    `describeUnsendableCode` (4: "marks the three no-status sentinels as such", "uses the
 *    separate peer-code marker…", "appends the peer's own reason after the marker", "emits a
 *    bare marker when the peer sent no reason"): the functions, and `STATION_CLOSE_REASONS`,
 *    are deleted from the route — they translated a close observed on one leg into one sendable
 *    on the other, and there is one leg;
 *  - frame relay (6): "relays agency control frames from core to the agent verbatim", "relays
 *    BRIDGE-originated frames too…", "relays the released frame with its reason intact",
 *    "relays agent frames up to core", "buffers agent frames sent before the upstream is
 *    open…", "survives a long session of many frames in both directions" — no relay, no pending
 *    buffer: the handler owns the console's socket and core's frames are its own sends;
 *  - close propagation / laundering (11): "propagates core's close code and reason to the
 *    agent", "substitutes a legal code when the peer closed without one", "carries the
 *    unsendable code in the close reason…", "logs the observed code alongside the code it
 *    actually sent", "does not mark a sendable code as laundered", "forwards core's %i
 *    verbatim…" (×2), "reports null rather than false on the cascade line…", "does not claim it
 *    forwarded a code to a core leg that was still upgrading", "marks exactly one close line per
 *    bridge as the initiating one", "names the agent-leg transport error on the wire and in the
 *    log" — core's own closes now reach the console directly; `STATION_CLOSE_DELIVERY` and the
 *    cascade accounting are deleted;
 *  - upstream lifecycle (2): "closes the upstream when the agent disconnects", "reports an
 *    unreachable core distinctly from core closing the socket" (`UPSTREAM_UNAVAILABLE`, 4502,
 *    is deleted) — there is no upstream.
 *
 * MODIFIED (2):
 *  - "refuses an upgrade with no token, without contacting core": asserts the station handler
 *    was never called, in place of `core.connections` being empty;
 *  - "forwards the session id and token to core on the upgrade": asserts `handleStationSocket`
 *    receives `(socket, sessionId, token, runtime)` — the token still round-tripped through a
 *    URL-significant character — in place of the fake core's upgrade path and query.
 *
 * NEW (1): "closes 1011 when the app has no agency runtime" — the route's one addition
 *  (`STATION_CLOSE_CODES.RUNTIME_UNAVAILABLE`, Phase 6's `registerStationSocket` behaviour),
 *  standing in the place of the deleted 4502 case: the refusal for "nothing to hand to".
 *
 * Kept verbatim (7): the four `rewriteStationWsUrl` cases and the three source-level "no RBAC
 * here" cases (the collapsed route still registers no session, tenant or RBAC hook and exactly
 * one route).
 */

const mocks = vi.hoisted(() => ({
  // A SHARED logger, not a fresh one per `createChildLogger` call: the close
  // accounting this proxy performs (`cascade`, `observedCode`, `sentCode`,
  // `laundered`) exists to be read out of these lines, so the tests have to be
  // able to read them too. A per-call mock is unreachable from here.
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // PORT NOTE (magick-agency): the station handler the route hands the socket to, and the
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

/** PORT NOTE (magick-agency): the route now takes the runtime getter. */
const RUNTIME = mocks.runtime;
const stationRoutes = (app: FastifyInstance) =>
  proxyAgencyStationRoutes(app, { getRuntime: () => mocks.runtime });

describe('rewriteStationWsUrl', () => {
  it('maps core\'s absolute URL onto master\'s prefix, preserving the token', () => {
    expect(
      rewriteStationWsUrl(`wss://core-host:3000/api/v1/agency/station/${SESSION}?token=secret`),
    ).toBe(`/proxy/agency/station/${SESSION}?token=secret`);
  });

  it('handles an already-relative path', () => {
    expect(rewriteStationWsUrl(`/api/v1/agency/station/${SESSION}?token=x`)).toBe(
      `/proxy/agency/station/${SESSION}?token=x`,
    );
  });

  it('preserves a multi-parameter query string verbatim', () => {
    expect(
      rewriteStationWsUrl(`wss://c/api/v1/agency/station/${SESSION}?token=x&v=2`),
    ).toBe(`/proxy/agency/station/${SESSION}?token=x&v=2`);
  });

  it('falls back to the original URL on an unexpected shape', () => {
    // Degrading to "client talks to core directly" beats minting a proxy path
    // that is guaranteed to 404.
    const odd = 'wss://core-host/some/other/path?token=x';
    expect(rewriteStationWsUrl(odd)).toBe(odd);
  });
});

// PORT NOTE (magick-agency): DELETED here — the `isSendableCloseCode` (20), `truncateCloseReason`
// (6) and `describeUnsendableCode` (4) describes; the functions are gone with the second leg
// (see the header).

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

  it('refuses an upgrade with no token, without contacting core', async () => {
    // An 8-hour socket that anyone can attach to is a standing invitation to
    // join someone else's dialing session. Failing before the upstream connect
    // also means a token-less flood costs master nothing upstream.
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}`);
    const closed = await client.waitForClose();

    expect(closed.code).toBe(STATION_CLOSE_CODES.MISSING_TOKEN);
    // PORT NOTE (magick-agency): was `expect(core.connections).toHaveLength(0)` — "core" is
    // the in-process station handler now.
    expect(mocks.handleStationSocket).not.toHaveBeenCalled();
  });

  it('forwards the session id and token to core on the upgrade', async () => {
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}?token=sec%2Fret`);
    // PORT NOTE (magick-agency): was `core.waitForConnections(1)` and the fake core's upgrade
    // path/query; the socket is handed to `handleStationSocket(socket, sessionId, token, runtime)`.
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

  // PORT NOTE (magick-agency): NEW — the route's one addition, in place of the deleted
  // "reports an unreachable core distinctly from core closing the socket" (4502).
  it('closes 1011 when the app has no agency runtime', async () => {
    mocks.runtime = null;
    const client = connectClient(`${proxy.url}${PREFIX}/${SESSION}?token=t`);
    const closed = await client.waitForClose();

    expect(closed.code).toBe(STATION_CLOSE_CODES.RUNTIME_UNAVAILABLE);
    expect(mocks.handleStationSocket).not.toHaveBeenCalled();
  });
});

describe('no RBAC here — verdict recorded, not left for the next reader to re-derive (`MAG-96`)', () => {
  /**
   * ── The question `MAG-96` asked ─────────────────────────────────────────────
   * `proxy-agency-agent.routes.ts` and `proxy-agency-campaigns.routes.ts` both
   * carry `requirePermission(...)` on every route (see
   * `proxy-agency-route-table.test.ts`'s "every agent action route carries its
   * RBAC permission" block). This file carries **zero**. Before this test, that
   * was indistinguishable from an omission — the same shape as the hole `MAG-96`
   * closed elsewhere. It is not an omission: it is structurally the ONLY option.
   *
   * `proxyAgencyStationRoutes` registers no `sessionMiddleware`, no
   * `tenantContextMiddleware`, and no RBAC hook at all (contrast the other two
   * files' `app.addHook('preHandler', sessionMiddleware)` etc.) — a browser
   * `WebSocket` cannot set an `Authorization` header on the upgrade request, so
   * master never gets a Firebase bearer token, never resolves `request.user` /
   * `request.membership`, and therefore has no role to run `requirePermission`
   * against on this path. Adding an RBAC preHandler here would not be a stronger
   * check; it would be `requirePermission` running against a session/membership
   * that were never populated, which throws or silently no-ops depending on how
   * it's mocked — worse than the honest absence.
   *
   * The real credential is core's session-scoped, single-use, ~2-minute station
   * token (see the file's own "Master is not the gate" comment, and Contract v2).
   * Master's whole contribution is refusing a *tokenless* upgrade before
   * spending an upstream connection on it — core is the sole authority on
   * whether a *present* token is valid. That refusal is what
   * "refuses an upgrade with no token, without contacting core" (above) already
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
