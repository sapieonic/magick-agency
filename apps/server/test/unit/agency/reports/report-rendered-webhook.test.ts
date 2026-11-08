// The render callback (`POST /webhooks/reports/rendered`) and the one apply path behind it
// (`applyRenderOutcome`): the signature over the raw bytes and its clock window, the body shape,
// the key-scope check (a callback cannot point a run at another tenant's object), the attempt
// fence (a stale attempt is acknowledged 204 and changes nothing) and the callback metric.
// The repository's SQL is pinned on Postgres by the integration round trip.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const metrics = vi.hoisted(() => ({ callbacks: vi.fn(), runs: vi.fn(), render: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agencyReportsCallbacksTotal: { inc: metrics.callbacks },
  agencyReportsRunsTotal: { inc: metrics.runs },
  agencyReportsRenderSeconds: { observe: metrics.render },
}));

import { REPORT_SIGNATURE_HEADER, REPORT_TIMESTAMP_HEADER, type ReportRenderCallback } from '@magick-agency/contracts/reports';
import { reportRenderedWebhookRoutes } from '../../../../src/api/routes/webhooks/report-rendered.js';
import { applyRenderOutcome, type ApplyRenderOutcomeDeps } from '../../../../src/agency/reports/apply.js';
import { signReportCallback, verifyReportCallback } from '../../../../src/agency/reports/callback-signature.js';
import { reportOutputKey } from '../../../../src/agency/reports/report-keys.js';
import { ACCOUNT, OTHER_ACCOUNT, RUN, TENANT, runRecord } from './run-fixture.js';

const SECRET = 'a-report-callback-secret-of-at-least-32-chars';
const NOW_MS = Date.parse('2026-11-08T12:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const scope = { tenantId: TENANT, accountId: ACCOUNT, runId: RUN };

function rendered(over: Partial<ReportRenderCallback> = {}): ReportRenderCallback {
  return {
    run_id: RUN,
    attempt: 2,
    status: 'rendered',
    files: [
      { format: 'pdf', key: reportOutputKey(scope, 'pdf'), bytes: 1200 },
      { format: 'xlsx', key: reportOutputKey(scope, 'xlsx'), bytes: 3400 },
    ],
    error: null,
    renderer_version: '1.0.0',
    ...over,
  };
}

/** The repository behind the real apply path: one run `rendering` under attempt 2. */
function repo(state: { attempt: number; status: string } = { attempt: 2, status: 'rendering' }) {
  return {
    findByIdAnyTenant: vi.fn(async () => runRecord({
      status: 'rendering', render_attempt: state.attempt, sent_at: new Date(NOW_MS - 30_000),
    })),
    applyRenderResult: vi.fn(async (_id: string, attempt: number, result: { status: string }) =>
      attempt === state.attempt && state.status === 'rendering'
        ? { result: 'applied' as const, run: runRecord({ status: result.status === 'rendered' ? 'ready' : 'failed' }) }
        : { result: 'stale' as const }),
  };
}

let app: FastifyInstance;
let r: ReturnType<typeof repo>;

async function build(state?: { attempt: number; status: string }, secret: string | null = SECRET) {
  r = repo(state);
  const deps: ApplyRenderOutcomeDeps = { repo: r, retentionDays: 90, now: () => new Date(NOW_MS) };
  app = Fastify({ logger: false });
  await app.register(reportRenderedWebhookRoutes, {
    prefix: '/webhooks',
    callbackSecret: secret ?? undefined,
    retentionDays: 90,
    apply: (runId, attempt, cb) => applyRenderOutcome(runId, attempt, cb, deps),
    nowMs: () => NOW_MS,
  });
  await app.ready();
}

function post(body: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/reports/rendered',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

function signed(body: string, ts: number = NOW_S, secret = SECRET) {
  return { [REPORT_TIMESTAMP_HEADER]: String(ts), [REPORT_SIGNATURE_HEADER]: signReportCallback(secret, ts, body) };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /webhooks/reports/rendered', () => {
  it('applies a correctly signed callback for the current attempt: 204, applied, the run ready', async () => {
    await build();
    const body = JSON.stringify(rendered());
    const res = await post(body, signed(body));
    expect(res.statusCode).toBe(204);
    expect(r.applyRenderResult).toHaveBeenCalledWith(RUN, 2, expect.objectContaining({ status: 'rendered', retentionDays: 90 }));
    expect(metrics.callbacks).toHaveBeenCalledWith({ result: 'applied' });
    expect(metrics.runs).toHaveBeenCalledWith({ kind: 'agent', status: 'ready' });
    expect(metrics.render).toHaveBeenCalledWith({ kind: 'agent' }, 30);
  });

  it('refuses a bad signature with 401 and writes nothing', async () => {
    await build();
    const body = JSON.stringify(rendered());
    const res = await post(body, signed(body, NOW_S, 'another-secret-entirely-of-32-chars-plus'));
    expect(res.statusCode).toBe(401);
    expect(r.findByIdAnyTenant).not.toHaveBeenCalled();
    expect(r.applyRenderResult).not.toHaveBeenCalled();
    expect(metrics.callbacks).toHaveBeenCalledWith({ result: 'bad_signature' });
  });

  it('signs the exact bytes: the same JSON re-serialised differently does not verify', async () => {
    await build();
    const body = JSON.stringify(rendered());
    const res = await post(JSON.stringify(rendered(), null, 2), signed(body));
    expect(res.statusCode).toBe(401);
  });

  it('refuses missing headers, and every callback when no secret is configured (inline)', async () => {
    await build();
    const body = JSON.stringify(rendered());
    expect((await post(body, {})).statusCode).toBe(401);
    await build(undefined, null);
    expect((await post(body, signed(body))).statusCode).toBe(401);
  });

  it('refuses a timestamp more than 300 s from the clock, either way; accepts at the edge', async () => {
    await build();
    const body = JSON.stringify(rendered());
    expect((await post(body, signed(body, NOW_S - 301))).statusCode).toBe(401);
    expect((await post(body, signed(body, NOW_S + 301))).statusCode).toBe(401);
    expect((await post(body, signed(body, NOW_S - 300))).statusCode).toBe(204);
  });

  it('refuses a body that is not a render callback: 400 invalid', async () => {
    await build();
    for (const body of ['not json', JSON.stringify({ run_id: RUN }), JSON.stringify(rendered({ attempt: 0 }))]) {
      const res = await post(body, signed(body));
      expect(res.statusCode, body).toBe(400);
    }
    expect(r.applyRenderResult).not.toHaveBeenCalled();
    expect(metrics.callbacks).toHaveBeenCalledWith({ result: 'invalid' });
  });

  it('refuses a file key outside the run\'s own output keys (another account\'s, another run\'s): 400, nothing written', async () => {
    await build();
    const foreign = reportOutputKey({ ...scope, accountId: OTHER_ACCOUNT }, 'pdf');
    const cases = [
      rendered({ files: [{ format: 'pdf', key: foreign, bytes: 1 }, rendered().files[1]!] }),
      rendered({ files: [{ format: 'pdf', key: 'reports/../secret.pdf', bytes: 1 }, rendered().files[1]!] }),
      rendered({ files: [{ format: 'xlsx', key: reportOutputKey(scope, 'pdf'), bytes: 1 }, rendered().files[1]!] }),
    ];
    for (const cb of cases) {
      const body = JSON.stringify(cb);
      const res = await post(body, signed(body));
      expect(res.statusCode).toBe(400);
    }
    expect(r.applyRenderResult).not.toHaveBeenCalled();
  });

  it('acknowledges a stale attempt with 204, counts it stale, and changes nothing', async () => {
    await build({ attempt: 3, status: 'rendering' });
    const body = JSON.stringify(rendered({ attempt: 2 }));
    const res = await post(body, signed(body));
    expect(res.statusCode).toBe(204);
    expect(metrics.callbacks).toHaveBeenCalledWith({ result: 'stale' });
    expect(metrics.runs).not.toHaveBeenCalled();
  });

  it('applies a failed callback with the renderer\'s code', async () => {
    await build();
    const body = JSON.stringify(rendered({ status: 'failed', files: [], error: { code: 'upload_failed', message: 'S3 said no' } }));
    const res = await post(body, signed(body));
    expect(res.statusCode).toBe(204);
    expect(r.applyRenderResult).toHaveBeenCalledWith(RUN, 2, expect.objectContaining({
      status: 'failed', error: { code: 'upload_failed', message: 'S3 said no' },
    }));
    expect(metrics.runs).toHaveBeenCalledWith({ kind: 'agent', status: 'failed' });
  });
});

describe('applyRenderOutcome', () => {
  const deps = (rp = repo()): ApplyRenderOutcomeDeps => ({ repo: rp, retentionDays: 30 });

  it('refuses a callback naming another run or attempt than the one applied', async () => {
    const rp = repo();
    expect(await applyRenderOutcome(RUN, 3, rendered(), deps(rp))).toMatchObject({ result: 'invalid' });
    expect(rp.findByIdAnyTenant).not.toHaveBeenCalled();
  });

  it('refuses a rendered callback missing a requested format', async () => {
    const rp = repo();
    const outcome = await applyRenderOutcome(RUN, 2, rendered({ files: [rendered().files[0]!] }), deps(rp));
    expect(outcome).toMatchObject({ result: 'invalid' });
    expect(rp.applyRenderResult).not.toHaveBeenCalled();
  });

  it('acknowledges a callback for a run that no longer exists as stale', async () => {
    const rp = repo();
    rp.findByIdAnyTenant.mockResolvedValueOnce(null as never);
    expect(await applyRenderOutcome(RUN, 2, rendered(), deps(rp))).toEqual({ result: 'stale' });
  });
});

describe('verifyReportCallback', () => {
  it('accepts the signature the renderer computes, in either case', () => {
    const sig = signReportCallback(SECRET, NOW_S, '{}');
    for (const signature of [sig, sig.toUpperCase()]) {
      expect(verifyReportCallback({ secret: SECRET, timestamp: String(NOW_S), signature, rawBody: '{}', nowMs: NOW_MS })).toEqual({ ok: true });
    }
  });

  it('names why it refused', () => {
    const base = { secret: SECRET, rawBody: '{}', nowMs: NOW_MS };
    expect(verifyReportCallback({ ...base, timestamp: 'abc', signature: 'x' })).toEqual({ ok: false, reason: 'missing' });
    expect(verifyReportCallback({ ...base, timestamp: String(NOW_S), signature: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyReportCallback({ ...base, timestamp: String(NOW_S - 1000), signature: signReportCallback(SECRET, NOW_S - 1000, '{}') }))
      .toEqual({ ok: false, reason: 'skew' });
  });
});
