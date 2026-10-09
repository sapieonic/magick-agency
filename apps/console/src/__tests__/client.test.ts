import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ORIGINATOR_HEADER, ORIGINATOR } from '../config';

// ─── hoisted mock state ──────────────────────────────────────────────────────
// Mirrors the conventions in src/__tests__/api/originator-header.test.ts:
// global fetch + firebase getAuth are stubbed before importing the module
// under test.

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  signOut: vi.fn(async () => {}),
  currentUser: null as { getIdToken: () => Promise<string> } | null,
  trackApiErrorEvent: vi.fn(),
}));

vi.stubGlobal('fetch', mocks.fetch);

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: mocks.currentUser, signOut: mocks.signOut }),
}));

vi.mock('../analytics/events', () => ({
  trackApiErrorEvent: mocks.trackApiErrorEvent,
}));

import { apiFetch, ApiError } from '../api/client';
import { markSessionStart, getSessionStart } from '../utils/session';
import { splitRequestId } from '../utils/errors';

// ─── helpers ─────────────────────────────────────────────────────────────────

function okJson(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function errJson(status: number, body: unknown = { message: 'nope' }, requestId?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (requestId) headers.set('x-request-id', requestId);
  return new Response(JSON.stringify(body), { status, headers });
}

function headersOf(callIndex = 0): Record<string, string> {
  const [, opts] = mocks.fetch.mock.calls[callIndex]!;
  return (opts as RequestInit & { headers: Record<string, string> }).headers;
}

/**
 * Replace window.location with a writable stub so the module's
 * `window.location.href = ...` redirect can be observed, and `pathname` can be
 * controlled to exercise the /login redirect guard.
 */
function stubLocation(pathname: string, search = '') {
  // `search` is stubbed too because `sessionExpiredLoginUrl` builds the return
  // path from `pathname + search + hash` — for `/station` the query IS the
  // destination, since a bare `/station` lands on "No campaign selected."
  const loc = { pathname, search, hash: '', href: '' };
  Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true });
  return loc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = null;
  localStorage.clear();
  stubLocation('/app/dashboard');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── success paths ───────────────────────────────────────────────────────────

describe('apiFetch — success', () => {
  it('returns parsed JSON on 200 and does not touch session/signout', async () => {
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(okJson({ hello: 'world' }));

    const result = await apiFetch<{ hello: string }>('/api/example');

    expect(result).toEqual({ hello: 'world' });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(getSessionStart()).toBe(1000);
  });

  it('returns undefined on 204 No Content', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await apiFetch('/api/example', { method: 'DELETE' });

    expect(result).toBeUndefined();
  });

  it('sets Authorization / X-Tenant-Id / X-Account-Id headers (regression guard)', async () => {
    mocks.currentUser = { getIdToken: () => Promise.resolve('tok') };
    mocks.fetch.mockResolvedValue(okJson());

    await apiFetch('/api/example', { method: 'POST', body: '{}' }, 'tenant-1', 'account-1');

    const headers = headersOf();
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['X-Tenant-Id']).toBe('tenant-1');
    expect(headers['X-Account-Id']).toBe('account-1');
    expect(headers[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
  });
});

// ─── 401 handling ────────────────────────────────────────────────────────────

describe('apiFetch — 401 session expiry', () => {
  it('clears the session, signs out of Firebase, and throws ApiError(401)', async () => {
    mocks.currentUser = { getIdToken: () => Promise.resolve('tok') };
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401, { message: 'expired' }));

    await expect(apiFetch('/api/example')).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 401,
    });

    expect(getSessionStart()).toBeNull(); // clearSessionStart() ran
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('redirects to /login?session=expired, CARRYING where they were', async () => {
    /**
     * The `next=` half is the point. A mid-shift 401 from the backend's six-hour
     * expiry is the commonest sign-out there is, and it used to dump everyone on
     * `/app` — so an agent lost their station and a supervisor lost the campaign
     * they were watching. `RequireAuth`'s `?next=` only ever covered the
     * never-signed-in case.
     */
    const loc = stubLocation('/app/dashboard');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    const url = new URL(loc.href, 'https://app.example');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('session')).toBe('expired');
    expect(url.searchParams.get('next')).toBe('/app/dashboard');
  });

  it('omits next= from the bare root, which the catch-all already sends to /app', async () => {
    // A parameter that changes nothing is noise in a URL a user may well see.
    const loc = stubLocation('/');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    expect(loc.href).toBe('/login?session=expired');
  });

  it('does NOT redirect when already on /login (guards against redirect loop)', async () => {
    const loc = stubLocation('/login');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    // Still signs out + clears the session, but does not bounce.
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(getSessionStart()).toBeNull();
    expect(loc.href).toBe('');
  });

  it('does NOT redirect when already on the AGENCY door either', async () => {
    /**
     * The guard used to be `pathname.startsWith('/login')`, which is `false` for
     * `/agency/login` — so the second sign-in page had no guard at all.
     *
     * What that costs is worse than the loop the guard is named for, and specific:
     * `sessionExpiredLoginUrl()` from `/agency/login` correctly resolves back to
     * `/agency/login?session=expired`, so assigning it is a FULL-PAGE RELOAD of the
     * page the agent is standing on. The form is wiped mid-sign-in and whatever
     * the page was about to say — a wrong-password error, or the "we don't
     * recognise that account" diagnosis, which renders while signed in and is
     * therefore live at exactly this moment — is replaced by a generic
     * session-expired notice for a session that never existed. And `signOut()`'s
     * failure is swallowed above, so if it did not take, the reloaded page 401s
     * and reassigns the same href: a reload loop with no exit.
     */
    const loc = stubLocation('/agency/login');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(getSessionStart()).toBeNull();
    expect(loc.href).toBe('');
  });

  it('DOES redirect from an ordinary path that merely shares the prefix', async () => {
    /*
      Guards the two cases above against a guard that over-matches. `/loginish` is
      an ordinary path; `startsWith('/login')` treated it as the login page and
      suppressed the bounce, so a 401 there left the user on a dead page with no
      sign-in prompt. The predicate now matches on a segment boundary.
    */
    const loc = stubLocation('/loginish');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    expect(new URL(loc.href, 'https://app.example').pathname).toBe('/login');
  });

  it('sends an agency surface to the agency door on expiry', async () => {
    // The mid-shift 401 at a station: re-authenticating under time pressure with a
    // customer waiting is the worst moment to be shown the marketing page.
    const loc = stubLocation('/station', '?campaign=camp-1');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toBeInstanceOf(ApiError);

    const url = new URL(loc.href, 'https://app.example');
    expect(url.pathname).toBe('/agency/login');
    expect(url.searchParams.get('next')).toBe('/station?campaign=camp-1');
  });

  it('still throws ApiError(401) even if signOut rejects', async () => {
    mocks.signOut.mockRejectedValueOnce(new Error('firebase down'));
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(401));

    await expect(apiFetch('/api/example')).rejects.toMatchObject({ statusCode: 401 });
    expect(getSessionStart()).toBeNull();
  });
});

// ─── non-401 errors ──────────────────────────────────────────────────────────

describe('apiFetch — non-401 errors', () => {
  it('does NOT clear the session or sign out on 500, and throws ApiError(500)', async () => {
    const loc = stubLocation('/app/dashboard');
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(500, { message: 'server error' }));

    await expect(apiFetch('/api/example')).rejects.toMatchObject({ statusCode: 500 });

    expect(getSessionStart()).toBe(1000); // session untouched
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(loc.href).toBe(''); // no redirect
  });

  it('does NOT clear the session or sign out on 403', async () => {
    markSessionStart(1000);
    mocks.fetch.mockResolvedValue(errJson(403, { message: 'forbidden' }));

    await expect(apiFetch('/api/example')).rejects.toMatchObject({ statusCode: 403 });

    expect(getSessionStart()).toBe(1000);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('captures Retry-After and Try again in N seconds on a 429', async () => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Retry-After': '18' });
    mocks.fetch.mockResolvedValue(new Response(
      JSON.stringify({ error: 'Too Many Requests', message: 'Rate limit exceeded. Try again in 18 seconds.', retryAfter: 18 }),
      { status: 429, headers },
    ));

    const err = await apiFetch('/api/example').catch((e) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(18);
  });

  it('tracks a sanitized api_error event with the response request id', async () => {
    mocks.fetch.mockResolvedValue(errJson(500, { message: 'server error' }, 'req_500'));

    await expect(
      apiFetch('https://api.example.com/proxy/calls/550e8400-e29b-41d4-a716-446655440000?phone=+14155551234'),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(mocks.trackApiErrorEvent).toHaveBeenCalledWith({
      status: 500,
      path: '/proxy/calls/:id',
      request_id: 'req_500',
    });
  });
});

// ─── masked errors + request id (ClickUp 86d3fh88c) ──────────────────────────

describe('apiFetch — masked errors & request id', () => {
  it('captures the x-request-id header and embeds it in masked 5xx messages', async () => {
    const body = { error: 'Internal Error', message: 'Something went wrong. Contact support.', statusCode: 502 };
    mocks.fetch.mockResolvedValue(errJson(502, body, 'req_xyz'));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(502);
    expect(err.isMasked).toBe(true);
    expect(err.requestId).toBe('req_xyz');
    // The id rides along in the message so it survives the hook layer.
    expect(splitRequestId(err.message)).toEqual({
      message: 'Something went wrong. Contact support.',
      requestId: 'req_xyz',
    });
  });

  it('prefers the header over the body requestId', async () => {
    const body = { error: 'Internal Error', message: 'm', requestId: 'body-id' };
    mocks.fetch.mockResolvedValue(errJson(500, body, 'header-id'));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;
    expect(err.requestId).toBe('header-id');
  });

  it('falls back to the body requestId when no header is present', async () => {
    const body = { error: 'Internal Error', message: 'm', requestId: 'body-id' };
    mocks.fetch.mockResolvedValue(errJson(500, body));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;
    expect(err.requestId).toBe('body-id');
  });

  it('does NOT mask field-level validation errors and does not embed an id', async () => {
    const body = { error: 'Validation Error', details: [{ message: 'name is required', path: ['name'] }] };
    mocks.fetch.mockResolvedValue(errJson(400, body, 'req_should_not_show'));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err.isMasked).toBe(false);
    // Validation message is shown unchanged (path-prefixed) — no request-id marker appended.
    expect(err.message).toBe('name: name is required');
    expect(splitRequestId(err.message).requestId).toBeUndefined();
    // The structured id is still captured from the header for correlation.
    expect(err.requestId).toBe('req_should_not_show');
  });

  it('decodes master’s `issues` array, the shape every automation write is refused with', async () => {
    // Master's automation routes reply `{ error: 'Bad Request', issues: [...] }`
    // — the same Zod issues as `details`, under a different key. Undecoded, the
    // first thing every route author does (add a route, save it before filling
    // an option) surfaced as the bare words "Bad Request".
    const body = {
      error: 'Bad Request',
      issues: [{ message: 'Array must contain at least 1 element(s)', path: ['actions', 1, 'arms', 0, 'steps'] }],
    };
    mocks.fetch.mockResolvedValue(errJson(400, body, 'req_1'));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err.message).toBe('actions.1.arms.0.steps: Array must contain at least 1 element(s)');
    expect(splitRequestId(err.message).requestId).toBeUndefined();
  });

  it('prefers the field-level `issues` over Fastify’s generic `message`', async () => {
    /*
      The real body, and the one the `issues` branch was added for. Fastify's
      default error shape carries `message`, and a handler that attaches its own
      `issues` usually leaves that message as the bare status text — so a
      decoder placed AFTER the `message` check never runs, and the author is
      back to reading "Bad Request" with nothing to act on. Planting only
      `{ error, issues }` cannot see that: it is the collision that matters.
    */
    const body = {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Bad Request',
      issues: [{ message: 'Required', path: ['actions', 0, 'channel'] }],
    };
    mocks.fetch.mockResolvedValue(errJson(400, body));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err.message).toBe('actions.0.channel: Required');
  });

  it('prefers the field-level `details` over a generic `message` too', async () => {
    // Core's key for the same array. Both had to move ahead of `message`, or
    // fixing one shape left the other behind it.
    const body = {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Bad Request',
      details: [{ message: 'must be a valid E.164 number', path: ['to'] }],
    };
    mocks.fetch.mockResolvedValue(errJson(400, body));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err.message).toBe('to: must be a valid E.164 number');
  });

  it('still shows a real `message` when the issues array says nothing readable', async () => {
    // Reordering must not cost the message its turn: an unreadable array falls
    // through to it, exactly as an absent one does.
    mocks.fetch.mockResolvedValue(errJson(400, {
      error: 'Bad Request',
      message: 'That automation name is already taken.',
      issues: [{ code: 'custom' }],
    }));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;
    expect(err.message).toBe('That automation name is already taken.');
  });

  it('summarises a long `issues` list instead of pasting all of it into a toast', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({ message: `problem ${i}`, path: [`f${i}`] }));
    mocks.fetch.mockResolvedValue(errJson(400, { error: 'Bad Request', issues }));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;

    expect(err.message).toContain('f0: problem 0');
    expect(err.message).toContain('and 2 more problems');
    expect(err.message).not.toContain('problem 4');
  });

  it('falls back to the error label when `issues` carries nothing readable', async () => {
    mocks.fetch.mockResolvedValue(errJson(400, { error: 'Bad Request', issues: [{ code: 'custom' }] }));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;
    expect(err.message).toBe('Bad Request');
  });

  it('keeps business 4xx (insufficient credits) message unchanged', async () => {
    mocks.fetch.mockResolvedValue(errJson(402, { message: 'Insufficient credits' }, 'req_1'));

    const err = (await apiFetch<unknown>('/api/example').catch((e) => e)) as ApiError;
    expect(err.isMasked).toBe(false);
    expect(err.message).toBe('Insufficient credits');
  });
});
