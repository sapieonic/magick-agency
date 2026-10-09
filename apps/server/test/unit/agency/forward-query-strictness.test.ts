import { describe, it, expect } from 'vitest';
import {
  forwardAllowedQuery,
  unknownQueryParamsError,
  ATTEMPT_QUERY_PARAMS,
  CONTACT_QUERY_PARAMS,
  PAGING_QUERY_PARAMS,
  PREAMBLE_QUERY_PARAMS,
} from '../../../src/agency/agency-spine.js';

/**
 * ─── UNKNOWN QUERY PARAMS ARE REFUSED, NOT DROPPED ──────────────────────────
 *
 * `forwardAllowedQuery` used to iterate the ALLOWLIST and never look at the request, so
 * a param the route did not know about vanished without trace and the request still
 * succeeded. For a filter that is the worst available outcome: a `?phone=` search
 * against a route whose allowlist lacked `phone` answered 200 with the person's
 * entire unfiltered history, which the console then presented as the calls
 * matching their search. The reader gets more rows than they asked for, every one
 * of them wrong, and nothing on screen says so.
 *
 * These pin the two halves that have to hold together: unknown keys refuse, and
 * the keys a route consumes ITSELF are not "unknown" — the `?preamble=` on the CSV
 * exports is read by the handler and deliberately never forwarded, so without the
 * exemption strictness would 400 every export.
 */

describe('forwardAllowedQuery — the allowlist', () => {
  it('forwards a named param', () => {
    const r = forwardAllowedQuery({ outcome: 'connected' }, ATTEMPT_QUERY_PARAMS);
    expect(r).toEqual({ ok: true, query: { outcome: 'connected' } });
  });

  it('joins a repeated param with a comma, the other accepted spelling', () => {
    const r = forwardAllowedQuery({ outcome: ['a', 'b'] }, ATTEMPT_QUERY_PARAMS);
    expect(r.ok && r.query.outcome).toBe('a,b');
  });

  /**
   * A cleared form field posts `?phone=`. Forwarding it would make an empty
   * search box look like a filter that matched nothing — so it is dropped, and
   * dropping a BLANK value is not the same defect as dropping an unknown key.
   */
  it('drops a blank value without refusing the request', () => {
    const r = forwardAllowedQuery({ phone: '   ' }, ATTEMPT_QUERY_PARAMS);
    expect(r).toEqual({ ok: true, query: {} });
  });

  it('omits a param the caller did not send', () => {
    const r = forwardAllowedQuery({}, ATTEMPT_QUERY_PARAMS);
    expect(r).toEqual({ ok: true, query: {} });
  });

  it('tolerates a missing query object entirely', () => {
    expect(forwardAllowedQuery(undefined, ATTEMPT_QUERY_PARAMS)).toEqual({ ok: true, query: {} });
    expect(forwardAllowedQuery(null, ATTEMPT_QUERY_PARAMS)).toEqual({ ok: true, query: {} });
  });
});

describe('forwardAllowedQuery — refusal', () => {
  it('refuses an unknown key', () => {
    const r = forwardAllowedQuery({ account_id: 'x' }, ATTEMPT_QUERY_PARAMS);
    expect(r).toEqual({ ok: false, unknown: ['account_id'] });
  });

  it('names every unknown key, sorted, so the refusal is actionable', () => {
    const r = forwardAllowedQuery(
      { user_id: 'x', agentUserId: 'y', outcome: 'connected' },
      ATTEMPT_QUERY_PARAMS,
    );
    expect(r).toEqual({ ok: false, unknown: ['agentUserId', 'user_id'] });
  });

  /**
   * A refusal must not leak a partial forward. If the caller sees a 400 the
   * request is over, so there must be no query object for a handler to use by
   * mistake — the result type makes that a compile-time guarantee, and this pins
   * the runtime shape too.
   */
  it('carries no forwarded query at all when it refuses', () => {
    const r = forwardAllowedQuery({ outcome: 'connected', nope: '1' }, ATTEMPT_QUERY_PARAMS);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('query');
  });

  it('refuses an unknown key even when its value is blank', () => {
    // A blank ALLOWED param is dropped; a blank UNKNOWN one is still unknown.
    // Otherwise `?account_id=` would be a way to probe the allowlist silently.
    expect(forwardAllowedQuery({ account_id: '' }, ATTEMPT_QUERY_PARAMS))
      .toEqual({ ok: false, unknown: ['account_id'] });
  });
});

describe('forwardAllowedQuery — params the route consumes itself', () => {
  /**
   * The regression strictness would otherwise have caused. `preamble` is read by
   * the CSV handlers (`wantsPreamble`) and never forwarded to the internal handlers, so it has to
   * be declared route-consumed rather than left to read as unknown.
   */
  it('permits a route-consumed key without forwarding it', () => {
    const r = forwardAllowedQuery(
      { outcome: 'connected', preamble: 'false' },
      ATTEMPT_QUERY_PARAMS,
      PREAMBLE_QUERY_PARAMS,
    );
    expect(r).toEqual({ ok: true, query: { outcome: 'connected' } });
  });

  it('still refuses an unknown key alongside a route-consumed one', () => {
    const r = forwardAllowedQuery(
      { preamble: 'false', nope: '1' },
      ATTEMPT_QUERY_PARAMS,
      PREAMBLE_QUERY_PARAMS,
    );
    expect(r).toEqual({ ok: false, unknown: ['nope'] });
  });

  /**
   * Without the exemption declared, the same request is a 400 — which is the
   * export-breaking failure, asserted directly so nobody removes the third
   * argument thinking it is decorative.
   */
  it('refuses preamble when the route does NOT declare it', () => {
    expect(forwardAllowedQuery({ preamble: 'false' }, ATTEMPT_QUERY_PARAMS))
      .toEqual({ ok: false, unknown: ['preamble'] });
  });
});

describe('the allowlists themselves', () => {
  /**
   * `phone` is the param whose silent drop caused the original defect. It is on
   * both spine lists and pinned here so a tidy-up cannot quietly remove it.
   */
  it('carries phone on both the attempt and contact lists', () => {
    expect(ATTEMPT_QUERY_PARAMS).toContain('phone');
    expect(CONTACT_QUERY_PARAMS).toContain('phone');
  });

  /**
   * The Contacts tab's third chip group. A tidy-up that drops this key
   * re-breaks Apply on "How the agent wrote it up" — 400, table stuck on
   * the previous page. Attempts filter by `disposition_code` (this
   * attempt's write-up), not the contact's latest disposition; a shared
   * name would 400 or silently no-op depending on which list it landed on.
   * `disposition` is the alias the tester guessed and the internal handlers do not read.
   */
  it('carries last_disposition on contacts only', () => {
    expect(CONTACT_QUERY_PARAMS).toContain('last_disposition');
    expect(ATTEMPT_QUERY_PARAMS).not.toContain('last_disposition');
    expect(CONTACT_QUERY_PARAMS).not.toContain('disposition');
    expect(CONTACT_QUERY_PARAMS).not.toContain('disposition_code');
  });

  /**
   * Paging is on the JSON lists only. The CSV path sets `cursor` and `limit`
   * itself to drain every page, and a caller-supplied one would fight it.
   */
  it('keeps paging out of the base filter lists', () => {
    for (const key of PAGING_QUERY_PARAMS) {
      expect(ATTEMPT_QUERY_PARAMS).not.toContain(key);
      expect(CONTACT_QUERY_PARAMS).not.toContain(key);
    }
  });
});

describe('unknownQueryParamsError', () => {
  /**
   * `details` is what the error mask treats as structured client feedback, so it
   * is what makes the offending names survive to the caller instead of being
   * flattened into a generic 400.
   */
  it('names the params in a details block the error mask preserves', () => {
    const body = unknownQueryParamsError(['account_id', 'user_id']);
    expect(body.code).toBe('unknown_query_params');
    expect(body.details).toEqual({ unknown: ['account_id', 'user_id'] });
    expect(body.message).toContain('account_id');
    expect(body.message).toContain('user_id');
  });
});
