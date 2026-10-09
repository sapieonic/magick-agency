import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { isUnsafeCorePath } from '../../../src/proxy/safe-core-path.js';

describe('isUnsafeCorePath', () => {
  it('accepts ordinary UUID collection paths', () => {
    expect(isUnsafeCorePath('/calls/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isUnsafeCorePath('/agency-campaigns/11111111-1111-4111-8111-111111111111/attempts')).toBe(false);
    expect(isUnsafeCorePath('/calls/11111111-1111-4111-8111-111111111111/recording')).toBe(false);
  });

  it('accepts the voices path that embeds its query string in `path`', () => {
    // proxy-voices.routes.ts: `path: /voices${qs}` rather than a `query` object.
    expect(isUnsafeCorePath('/voices?ai_pipeline=gemini-live')).toBe(false);
    expect(isUnsafeCorePath('/voices')).toBe(false);
  });

  it('accepts the already-percent-encoded interpolations that exist today', () => {
    // `encodeURIComponent` output must survive the probe unchanged, or the
    // feature-flag / by-phone / alert routes would 400 on every call.
    expect(isUnsafeCorePath(`/inbound-phone-numbers/by-phone/${encodeURIComponent('+919876543210')}`)).toBe(false);
    expect(isUnsafeCorePath(`/feature-flags/${encodeURIComponent('webrtc_calls_enabled')}/overrides`)).toBe(false);
    expect(isUnsafeCorePath(`/feature-flags/${encodeURIComponent('a flag key')}`)).toBe(false);
  });

  it('rejects the path-spine interpolation (`..` + `?` truncation)', () => {
    expect(isUnsafeCorePath('/agency-campaigns/x/../../knowledge-bases?/attempts')).toBe(true);
  });

  it('rejects `..` segments that walk out of /api/v1/calls/:id/recording', () => {
    expect(isUnsafeCorePath('/calls/x/../../knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/../knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/../recording')).toBe(true);
  });

  it('rejects a param that is only `..` or `.`', () => {
    expect(isUnsafeCorePath('/prompts/..')).toBe(true);
    expect(isUnsafeCorePath('/prompts/.')).toBe(true);
  });

  /**
   * Everything below is a dot segment the WHATWG URL parser resolves but a
   * literal `=== '..'` segment test does not see. Each arrives through one
   * find-my-way decode of a double-encoded param (`%252e` → `%2e`), so they
   * are reachable from the wire, not just from a unit test.
   */
  it('rejects percent-encoded dot segments', () => {
    expect(isUnsafeCorePath('/calls/x/%2e%2e/%2e%2e/knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/x/%2E%2E/knowledge-bases')).toBe(true);
    expect(isUnsafeCorePath('/prompts/%2e')).toBe(true);
    expect(isUnsafeCorePath('/prompts/%2E')).toBe(true);
  });

  it('rejects half-encoded dot segments (`.%2e`, `%2e.`)', () => {
    expect(isUnsafeCorePath('/calls/x/.%2e/.%2e/knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/x/%2e./knowledge-bases')).toBe(true);
  });

  it('rejects dot segments hidden behind TAB/LF/CR, which the parser strips', () => {
    expect(isUnsafeCorePath('/calls/x/.\t./../knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/x/.\n./../knowledge-bases/recording')).toBe(true);
    expect(isUnsafeCorePath('/calls/x/.%09./%2e%2e/knowledge-bases/recording')).toBe(true);
  });

  it('rejects `#`, whose fragment is dropped rather than sent to the internal handler', () => {
    // `DELETE /proxy/webrtc-call/<id>%23/transcript` decodes to this path, and
    // fetch() would send `DELETE /webrtc-call/<id>` — deleting the call rather
    // than its transcript. (An `%23` that survives find-my-way still encoded is
    // harmless: the parser keeps it, so the handler sees a `#` inside the id.)
    expect(isUnsafeCorePath('/webrtc-call/11111111-1111-4111-8111-111111111111#/transcript')).toBe(true);
    expect(isUnsafeCorePath('/webrtc-call/abc#/transcript')).toBe(true);
    expect(isUnsafeCorePath('/webrtc-call/11111111-1111-4111-8111-111111111111%23/transcript')).toBe(false);
  });

  it('rejects a backslash and a relative (non-absolute) path', () => {
    expect(isUnsafeCorePath('/calls/foo\\bar')).toBe(true);
    expect(isUnsafeCorePath('calls/foo')).toBe(true);
    expect(isUnsafeCorePath('')).toBe(true);
  });

  it('does not treat a nested-but-non-traversing extra segment as unsafe', () => {
    // `/` in a param that is not `.`/`..` is still a different path, but
    // it cannot walk *up* the tree; it 404s. The choke point is traversal.
    expect(isUnsafeCorePath('/calls/foo/bar/recording')).toBe(false);
  });

  it('agrees with what fetch() would actually request', () => {
    // The property under test, stated directly: for every accepted path the
    // URL fetch() builds must still be the path we wrote. Guards against a
    // future relaxation that accepts something the parser rewrites.
    const accepted = [
      '/calls/11111111-1111-4111-8111-111111111111/recording',
      '/voices?ai_pipeline=gemini-live',
      '/calls/foo/bar/recording',
      `/inbound-phone-numbers/by-phone/${encodeURIComponent('+919876543210')}`,
    ];
    for (const path of accepted) {
      expect(isUnsafeCorePath(path)).toBe(false);
      const url = new URL(`https://core.test/api/v1${path}`);
      expect(url.pathname + url.search).toBe(`/api/v1${path}`);
    }
  });
});

/**
 * The unit cases above take the decoded path as a given. This closes the loop
 * on where that decoded path comes from: a real Fastify instance, routing a
 * real wire URL, handing a real `request.params` to a real interpolation.
 *
 * find-my-way decodes a param EXACTLY ONCE, which is why double-encoding is the
 * carrier — `%252e` on the wire is `%2e` in the handler, and `%2e` is what the
 * URL parser (not the string match the guard used to do) reads as a dot.
 */
describe('the wire → param → interpolated path chain', () => {
  async function pathBuiltFor(url: string): Promise<string> {
    const app = Fastify();
    let built = '';
    app.get<{ Params: { id: string } }>('/proxy/calls/:id/recording', async (request) => {
      built = `/calls/${request.params.id}/recording`;
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url });
    await app.close();
    expect(res.statusCode).toBe(200);
    return built;
  }

  const CORE = 'https://core.test/api/v1';

  it('refuses the double-encoded traversal that reaches another collection', async () => {
    const built = await pathBuiltFor('/proxy/calls/x%2F%252e%252e%2F%252e%252e%2Fknowledge-bases/recording');

    // What the handler actually hands to proxyToCore…
    expect(built).toBe('/calls/x/%2e%2e/%2e%2e/knowledge-bases/recording');
    // …and where fetch() would have sent it: past the `knowledge_bases`
    // capability gate, onto a collection this route never checked.
    expect(new URL(CORE + built).pathname).toBe('/api/v1/knowledge-bases/recording');
    expect(isUnsafeCorePath(built)).toBe(true);
  });

  it('refuses the whitespace variant, which the parser strips before parsing', async () => {
    const built = await pathBuiltFor('/proxy/calls/x%2F.%2509.%2F%252e%252e%2Fknowledge-bases/recording');

    expect(new URL(CORE + built).pathname).not.toBe(`/api/v1${built}`);
    expect(isUnsafeCorePath(built)).toBe(true);
  });

  it('leaves an ordinary call id alone', async () => {
    const built = await pathBuiltFor('/proxy/calls/11111111-1111-4111-8111-111111111111/recording');

    expect(built).toBe('/calls/11111111-1111-4111-8111-111111111111/recording');
    expect(new URL(CORE + built).pathname).toBe(`/api/v1${built}`);
    expect(isUnsafeCorePath(built)).toBe(false);
  });
});
