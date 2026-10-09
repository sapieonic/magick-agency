/**
 * PORT NOTE (magick-agency): cusui's `saFetchRaw.test.ts` (31 cases) tested
 * `saFetchRaw`, deleted here with its only consumer (the credits-usage CSV
 * export), plus `saError` through `saFetch`. The `saFetchRaw` cases that have an
 * `saFetch` counterpart are ported against `saFetch` (token, 401, non-ok,
 * masked errors) and the `saError` block is verbatim. See PORTING.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch before importing the module under test.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.stubGlobal('fetch', mocks.fetch);

// We must also stub window.location because happy-dom allows it.
Object.defineProperty(window, 'location', {
  value: { href: '' },
  writable: true,
});

import { saFetch, setToken, clearToken, SuperAdminApiError } from '../../api/super-admin';
import { ORIGINATOR_HEADER, ORIGINATOR } from '../../config';
import { splitRequestId } from '../../utils/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOkResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function makeErrResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearToken(); // always start with no token
  window.location.href = '';
});

afterEach(() => {
  clearToken();
  vi.clearAllMocks();
});

describe('saFetch — Bearer token', () => {
  it('adds Authorization header when a token is in sessionStorage', async () => {
    setToken('my-jwt-token');
    mocks.fetch.mockResolvedValue(makeOkResponse());

    await saFetch('/super-admin/tenants?tenant_id=t1');

    const [, opts] = mocks.fetch.mock.calls[0]!;
    expect((opts as RequestInit & { headers: Record<string, string> }).headers['Authorization'])
      .toBe('Bearer my-jwt-token');
  });

  it('omits Authorization header when no token is stored', async () => {
    mocks.fetch.mockResolvedValue(makeOkResponse());

    await saFetch('/super-admin/tenants?tenant_id=t1');

    const [, opts] = mocks.fetch.mock.calls[0]!;
    expect((opts as RequestInit & { headers: Record<string, string> }).headers['Authorization'])
      .toBeUndefined();
  });

  it('passes custom options (including signal) through to fetch', async () => {
    setToken('tok');
    const controller = new AbortController();
    mocks.fetch.mockResolvedValue(makeOkResponse());

    await saFetch('/url', { signal: controller.signal });

    const [, opts] = mocks.fetch.mock.calls[0]!;
    expect((opts as RequestInit).signal).toBe(controller.signal);
  });
});

describe('saFetch — 401 handling', () => {
  it('clears the token on 401', async () => {
    setToken('expired-token');
    mocks.fetch.mockResolvedValue(new Response('', { status: 401 }));

    await expect(saFetch('/url')).rejects.toThrow('Session expired');

    // Token must have been cleared.
    // Verify by calling saFetch again — no Authorization header this time.
    mocks.fetch.mockResolvedValue(makeOkResponse());
    await saFetch('/url');
    const [, opts] = mocks.fetch.mock.calls[1]!;
    expect((opts as RequestInit & { headers: Record<string, string> }).headers['Authorization'])
      .toBeUndefined();
  });

  it('redirects to /login on 401', async () => {
    setToken('expired');
    mocks.fetch.mockResolvedValue(new Response('', { status: 401 }));

    await expect(saFetch('/url')).rejects.toThrow();
    expect(window.location.href).toBe('/login');
  });

  it('throws an error with message "Session expired" on 401', async () => {
    setToken('tok');
    mocks.fetch.mockResolvedValue(new Response('', { status: 401 }));

    await expect(saFetch('/url')).rejects.toThrow('Session expired');
  });
});

describe('saFetch — non-ok responses', () => {
  it('extracts error message from JSON body when available', async () => {
    mocks.fetch.mockResolvedValue(
      makeErrResponse(400, { message: 'Bad tenant_id' }),
    );

    await expect(saFetch('/url')).rejects.toThrow('Bad tenant_id');
  });

  it('preserves the numeric status and response details for structured handling', async () => {
    const details = { error: 'Conflict', message: 'Allocation changed', current_version: 4 };
    mocks.fetch.mockResolvedValue(makeErrResponse(409, details));

    const err = await saFetch('/url').catch((value: unknown) => value);

    expect(err).toBeInstanceOf(SuperAdminApiError);
    expect(err).toMatchObject({ statusCode: 409, details });
  });

  it('falls back to "API error N" when body has no message field', async () => {
    mocks.fetch.mockResolvedValue(
      makeErrResponse(500, { error: 'internal' }),
    );

    await expect(saFetch('/url')).rejects.toThrow('API error 500');
  });

  it('falls back to statusText when body is not JSON', async () => {
    // A response whose .json() call fails.
    const res = new Response('not-json', {
      status: 503,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
    });
    // Override json() to simulate parse failure.
    const origJson = res.json.bind(res);
    vi.spyOn(res, 'json').mockRejectedValue(new SyntaxError('bad json'));
    mocks.fetch.mockResolvedValue(res);

    await expect(saFetch('/url')).rejects.toThrow();
    origJson; // keep reference
  });

  it('does NOT throw when status is 200 OK, and returns the parsed JSON body', async () => {
    mocks.fetch.mockResolvedValue(makeOkResponse({ ok: true }));
    const res = await saFetch<{ ok: boolean }>('/url');
    expect(res).toEqual({ ok: true });
  });
});
describe('saFetch — masked errors & request id', () => {
  function maskedRes(status: number, body: unknown, requestId?: string): Response {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (requestId) headers.set('x-request-id', requestId);
    return new Response(JSON.stringify(body), { status, headers });
  }

  it('embeds the x-request-id into the message for masked 5xx errors', async () => {
    mocks.fetch.mockResolvedValue(
      maskedRes(502, { error: 'Internal Error', message: 'Something went wrong.' }, 'req_sa_1'),
    );

    const err = (await saFetch('/url').catch((e: unknown) => e)) as Error;
    expect(splitRequestId(err.message)).toEqual({
      message: 'Something went wrong.',
      requestId: 'req_sa_1',
    });
  });

  it('does NOT embed an id for field-level validation errors', async () => {
    mocks.fetch.mockResolvedValue(
      maskedRes(400, { error: 'Request Failed', details: [{ message: 'bad' }], message: 'bad' }, 'req_sa_2'),
    );

    const err = (await saFetch('/url').catch((e: unknown) => e)) as Error;
    expect(splitRequestId(err.message).requestId).toBeUndefined();
  });
});


describe('saFetch — originator header', () => {
  it('is sent on super-admin saFetch requests', async () => {
    mocks.fetch.mockResolvedValue(makeOkResponse());

    await saFetch('/super-admin/me');

    const [, opts] = mocks.fetch.mock.calls[0]!;
    expect((opts as RequestInit & { headers: Record<string, string> }).headers[ORIGINATOR_HEADER]).toBe(ORIGINATOR);
  });
});

// ── Error message resolution ─────────────────────────────────────────────────
// magic-voice-core answers a validation failure with
// `{ error: 'Validation Error', details: [...zod issues] }` and NO top-level
// `message`, so every one of its carefully-worded messages used to surface as
// the literal string "API error 400". This is a shared super-admin helper, so
// it affects every super-admin screen.

describe('saError — message resolution', () => {
  function errRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    });
  }

  async function messageFor(res: Response): Promise<string> {
    mocks.fetch.mockResolvedValue(res);
    const err = (await saFetch('/url').catch((e: unknown) => e)) as SuperAdminApiError;
    expect(err).toBeInstanceOf(SuperAdminApiError);
    return err.message;
  }

  it('keeps taking a top-level message — the masked contract is unchanged', async () => {
    const msg = await messageFor(
      errRes(502, { error: 'Internal Error', message: 'Something went wrong.' }, { 'x-request-id': 'req_1' }),
    );
    expect(splitRequestId(msg)).toEqual({
      message: 'Something went wrong.',
      requestId: 'req_1',
    });
  });

  it('prefers a top-level message over a zod issue when both are present', async () => {
    const msg = await messageFor(
      errRes(400, { message: 'Top level wins', details: [{ message: 'issue detail' }] }),
    );
    expect(msg).toBe('Top level wins');
  });

  it('reads the first zod issue when core sends no top-level message', async () => {
    const msg = await messageFor(
      errRes(400, {
        error: 'Validation Error',
        details: [
          {
            code: 'custom',
            path: ['status'],
            message: 'Unknown status "canceled" for offering "ai_calls". Valid values: queued, initiating',
          },
          { code: 'custom', path: ['offset'], message: 'second issue' },
        ],
      }),
    );
    expect(msg).toBe(
      'Unknown status "canceled" for offering "ai_calls". Valid values: queued, initiating',
    );
  });

  it('does not append a request id to a validation error', async () => {
    const msg = await messageFor(
      errRes(400, { error: 'Validation Error', details: [{ message: 'bad offset' }] }, { 'x-request-id': 'req_2' }),
    );
    expect(splitRequestId(msg).requestId).toBeUndefined();
  });

  it('skips issues carrying no usable message', async () => {
    const msg = await messageFor(
      errRes(400, { details: [{ code: 'custom' }, { message: '' }, { message: 'the real one' }] }),
    );
    expect(msg).toBe('the real one');
  });

  it('accepts a plain string issue list', async () => {
    const msg = await messageFor(errRes(400, { details: ['plain string issue'] }));
    expect(msg).toBe('plain string issue');
  });

  it('falls back to the status string when there is neither', async () => {
    expect(await messageFor(errRes(409, { error: 'Conflict' }))).toBe('API error 409');
    expect(await messageFor(errRes(400, {}))).toBe('API error 400');
  });

  it.each([
    ['a string', 'not an object'],
    ['null', null],
    ['a number', 42],
    ['an array', ['top', 'level', 'array']],
  ])('never throws on a malformed body (%s)', async (_label, body) => {
    // An error handler that throws replaces a readable failure with a crash.
    expect(await messageFor(errRes(400, body))).toBe('API error 400');
  });

  it.each([
    ['an object', { fieldErrors: { status: ['bad'] } }],
    ['a string', 'details-as-string'],
    ['a number', 7],
    ['an empty array', []],
  ])('never throws when `details` is %s rather than an issue list', async (_label, details) => {
    expect(await messageFor(errRes(400, { details }))).toBe('API error 400');
  });
});
