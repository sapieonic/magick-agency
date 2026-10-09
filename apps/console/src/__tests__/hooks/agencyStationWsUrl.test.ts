import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The station socket's URL resolution, and specifically **which host it points
 * at**.
 *
 * This lives in its own file because it is the one thing about
 * `useAgencyStation` that depends on `API_BASE`, and varying `API_BASE` means
 * mocking `../../config` for the whole module graph — which would be an odd
 * thing to impose on the 1,000-line behavioural suite next door.
 *
 * ── What this is protecting, stated as the failure ──────────────────────────
 *
 * Master's `rewriteStationWsUrl` deliberately returns a PATH
 * (`/proxy/agency/station/<id>?token=…`), so the client chooses the host. The
 * original implementation chose `window.location.host`, which is right in dev
 * (Vite proxies `/proxy` to master, `API_BASE` empty) and on a single-origin
 * deploy, and wrong on every split-origin one. On staging the page is served
 * from `staging.app.magickvoice.com` and master from
 * `staging.appi.magickvoice.com`, so the upgrade hit the SPA's own history
 * fallback and came back `200 text/html`. A handshake answered 200 never
 * reaches 101, so no close code is ever delivered, the console can only report
 * a bare transport failure, and its retry loop re-mints a token and tries
 * again indefinitely.
 *
 * The test it replaced asserted `toMatch(/^wss?:\/\//)` and that the path
 * survived — i.e. that a path had become *a* URL, never that it addressed the
 * API. It passed against the defect for the whole life of the bug. Every case
 * here therefore asserts the **full URL**, host included.
 */

const cfg = vi.hoisted(() => ({ apiBase: '' }));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  // A getter, not a value: `toAbsoluteWsUrl` reads `API_BASE` at call time, so
  // this lets one module instance serve every case below.
  return { ...actual, get API_BASE() { return cfg.apiBase; } };
});
vi.mock('../../api/agency', () => ({ mintStationToken: vi.fn() }));

import { toAbsoluteWsUrl } from '../../hooks/useAgencyStation';

const STATION_PATH = '/proxy/agency/station/944008a2-78fa-475b-8c98-cd4b52f6aad9?token=t1';

describe('toAbsoluteWsUrl', () => {
  beforeEach(() => {
    cfg.apiBase = '';
  });

  it('points at API_BASE, not the page, when they are different origins', () => {
    // The staging shape verbatim. The page is on `app.`, master is on `appi.`,
    // and the pre-fix implementation produced the `app.` host here — which is
    // the SPA, which answers 200 with index.html.
    cfg.apiBase = 'https://staging.appi.magickvoice.com';
    expect(toAbsoluteWsUrl(STATION_PATH)).toBe(
      `wss://staging.appi.magickvoice.com${STATION_PATH}`,
    );
  });

  it('takes the scheme from API_BASE rather than the page', () => {
    // Not cosmetic: an https page resolving a plaintext API base must produce
    // `ws:`, and the browser will refuse it as mixed content — which is the
    // correct, visible outcome. Deriving the scheme from the page instead would
    // produce a `wss:` URL to a listener that speaks plaintext, and the failure
    // would look like a network fault rather than a configuration one.
    cfg.apiBase = 'http://localhost:3010';
    expect(toAbsoluteWsUrl(STATION_PATH)).toBe(`ws://localhost:3010${STATION_PATH}`);
  });

  it('falls back to the page origin when API_BASE is empty (dev, via the Vite proxy)', () => {
    expect(toAbsoluteWsUrl(STATION_PATH)).toBe(
      `ws://${window.location.host}${STATION_PATH}`,
    );
  });

  it('handles a RELATIVE API_BASE instead of throwing', () => {
    // `new URL('/api')` throws. The sibling resolvers (`useBrowserCall`,
    // `buildWsUrl`) would take that exception on a same-origin-with-prefix
    // deployment; this one resolves against the page URL.
    cfg.apiBase = '/api';
    expect(toAbsoluteWsUrl(STATION_PATH)).toBe(
      `ws://${window.location.host}${STATION_PATH}`,
    );
  });

  it('uses only the ORIGIN of API_BASE, never its path prefix', () => {
    // Matches the two sibling resolvers, which both read `baseUrl.host` alone.
    // The socket path is master's own rewrite and is already absolute from the
    // host root, so joining a base prefix onto it would corrupt it.
    cfg.apiBase = 'https://api.example.com/v2';
    expect(toAbsoluteWsUrl(STATION_PATH)).toBe(`wss://api.example.com${STATION_PATH}`);
  });

  it('passes an absolute ws(s) URL through untouched, even with API_BASE set', () => {
    // `rewriteStationWsUrl` falls back to core's own absolute URL when it does
    // not recognise the shape, so the client can still reach core directly.
    // Re-hosting that onto master would break the one case the fallback exists
    // for.
    cfg.apiBase = 'https://staging.appi.magickvoice.com';
    expect(toAbsoluteWsUrl('wss://core.internal/api/v1/agency/station/s1?token=t')).toBe(
      'wss://core.internal/api/v1/agency/station/s1?token=t',
    );
  });

  it('tolerates a path with no leading slash', () => {
    cfg.apiBase = 'https://staging.appi.magickvoice.com';
    expect(toAbsoluteWsUrl('proxy/agency/station/s1')).toBe(
      'wss://staging.appi.magickvoice.com/proxy/agency/station/s1',
    );
  });
});
