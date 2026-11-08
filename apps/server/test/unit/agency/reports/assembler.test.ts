// The report assembler over a fake builder, a fake S3 and a fake dispatcher: the detail cap
// (RP12: the iterator's `return()` is called, the file and the run are `truncated`), the gzipped
// NDJSON it writes, the dataset it records, the claim fence (a refused write stops it), the claim
// ceiling, the error mapping (a subscription stops only when the tick's probe agrees its subject
// is gone; a changed campaign zone is `subject_changed`), the no-overlap loop, the first pass's
// orphan reclaim and the bounded stop. The claim SQL and the fenced writes are
// pinned on Postgres by the repository's integration tests and the reports round trip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { Readable } from 'node:stream';

const metrics = vi.hoisted(() => ({ runs: vi.fn(), assemble: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agencyReportsRunsTotal: { inc: metrics.runs },
  agencyReportsAssembleSeconds: { observe: metrics.assemble },
}));

import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import {
  createReportAssembler,
  startReportAssembler,
  streamDetailFile,
  type ReportAssemblerDeps,
} from '../../../../src/agency/reports/assembler.js';
import type { ReportSubscriptionSubject } from '../../../../src/agency/reports/subscription-subject.js';
import {
  ReportSubjectUnavailableError,
  ReportZoneChangedError,
  type ReportDatasetBuilder,
  type ReportDetailSource,
} from '../../../../src/agency/reports/datasets/index.js';
import { reportDatasetKey, reportDetailKey } from '../../../../src/agency/reports/report-keys.js';
import type { ReportRunRecord } from '../../../../src/db/repositories/agency.repository.js';
import { ACCOUNT, RUN, SUBSCRIPTION, TENANT, runRecord } from './run-fixture.js';

const scope = { tenantId: TENANT, accountId: ACCOUNT, runId: RUN };

/** S3 in memory: every object's bytes, read off the stream the assembler hands it. */
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    uploadStream: vi.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      objects.set(key, bytes);
      return bytes.length;
    }),
    uploadJson: vi.fn(async (key: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      objects.set(key, bytes);
      return bytes.length;
    }),
  };
}

/** A detail source of `n` rows that records whether `return()` was called. */
function source(sheet: ReportDetailSource['sheet'], n: number) {
  const state = { yielded: 0, returned: false };
  const src: ReportDetailSource = {
    sheet,
    label: sheet,
    columns: [{ key: 'i', label: 'Row', type: 'int' }],
    rows: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (state.yielded >= n) return { done: true as const, value: undefined };
            state.yielded += 1;
            return { done: false as const, value: [state.yielded] };
          },
          async return() {
            state.returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    }),
  };
  return { src, state };
}

const datasetOf = (run: ReportRunRecord) => ({
  dataset_version: 1, run_id: run.id, kind: run.kind, audience: run.audience,
  generated_at: '2026-11-08T00:00:00.000Z', marker: 'dataset',
}) as never;

function builders(build: ReportDatasetBuilder): Record<ReportKind, ReportDatasetBuilder> {
  return { agent: build, campaign: build, account: build };
}

function deps(over: Partial<ReportAssemblerDeps> = {}, run = runRecord({ status: 'assembling' })) {
  const queue: Array<ReportRunRecord | null> = [run, null];
  const storage = fakeStorage();
  const d = {
    repo: {
      claimNextQueued: vi.fn(async (_staleBefore: Date): Promise<ReportRunRecord | null> => queue.shift() ?? null),
      markAssembled: vi.fn(async (..._args: unknown[]) => true),
      markSent: vi.fn(async (..._args: unknown[]): Promise<number | null> => 1),
      markFailed: vi.fn(async (id: string, code: string, ..._rest: unknown[]) => runRecord({ id, status: 'failed', error_code: code as never })),
    },
    subscriptions: { disable: vi.fn(async (_id: string) => true) },
    // The tick's probe: by default the subject is gone (the builder's refusal stands).
    subject: vi.fn(async (_ref: unknown): Promise<ReportSubscriptionSubject> => ({ available: false, reason: 'the campaign no longer exists in the account' })),
    builders: builders(async (ctx) => ({ dataset: datasetOf(ctx.run), details: [] })),
    storage,
    dispatcher: { dispatch: vi.fn(async (..._args: unknown[]) => {}), idle: vi.fn(async () => {}) },
    now: () => new Date('2026-11-08T10:00:00Z'),
  };
  return Object.assign(d, over) as typeof d;
}

const opts = { intervalMs: 60_000, maxDetailRows: 5, maxAttempts: 3 };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('streamDetailFile', () => {
  it('writes gzipped NDJSON, one JSON array per line, in source order', async () => {
    const storage = fakeStorage();
    const { src, state } = source('calls', 3);
    const out = await streamDetailFile(src, 'k', 5, storage);
    expect(out).toEqual({ rows: 3, truncated: false });
    expect(gunzipSync(storage.objects.get('k')!).toString('utf8')).toBe('[1]\n[2]\n[3]\n');
    expect(state.returned).toBe(false);
  });

  it('stops at the cap: truncated, return() called, exactly the cap written', async () => {
    const storage = fakeStorage();
    const { src, state } = source('calls', 50);
    const out = await streamDetailFile(src, 'k', 5, storage);
    expect(out).toEqual({ rows: 5, truncated: true });
    expect(state.returned).toBe(true);
    expect(gunzipSync(storage.objects.get('k')!).toString('utf8').trim().split('\n')).toHaveLength(5);
    // It read one row past the cap to learn there was more, and no further.
    expect(state.yielded).toBe(6);
  });

  it('a source of exactly the cap is not truncated', async () => {
    const storage = fakeStorage();
    const { src, state } = source('calls', 5);
    expect(await streamDetailFile(src, 'k', 5, storage)).toEqual({ rows: 5, truncated: false });
    expect(state.returned).toBe(false);
  });

  it('a source that throws fails the upload and releases the iterator', async () => {
    const storage = fakeStorage();
    let returned = false;
    const src: ReportDetailSource = {
      sheet: 'calls', label: 'Calls', columns: [],
      rows: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => { throw new Error('cursor died'); },
          return: async () => { returned = true; return { done: true as const, value: undefined }; },
        }),
      }),
    };
    await expect(streamDetailFile(src, 'k', 5, storage)).rejects.toThrow('cursor died');
    expect(returned).toBe(true);
  });
});

describe('assembling one run', () => {
  it('builds, streams every detail sheet, records the dataset with detail_files, sends it', async () => {
    const calls = source('calls', 50);
    const sessions = source('sessions', 2);
    const d = deps({
      builders: builders(async (ctx) => ({ dataset: datasetOf(ctx.run), details: [sessions.src, calls.src] })),
    });
    const [outcome] = (await createReportAssembler(opts, d).drain(() => false));
    expect(outcome).toEqual({ runId: RUN, outcome: 'sent', attempt: 1 });

    const datasetKey = reportDatasetKey(scope);
    const dataset = JSON.parse(d.storage.objects.get(datasetKey)!.toString('utf8'));
    expect(dataset.marker).toBe('dataset');
    expect(dataset.detail_files).toEqual([
      { sheet: 'sessions', label: 'sessions', key: reportDetailKey(scope, 'sessions'), rows: 2, truncated: false, columns: sessions.src.columns },
      { sheet: 'calls', label: 'calls', key: reportDetailKey(scope, 'calls'), rows: 5, truncated: true, columns: calls.src.columns },
    ]);
    expect(calls.state.returned).toBe(true);
    expect(d.repo.markAssembled).toHaveBeenCalledWith(RUN, 1, {
      datasetKey, detailFiles: dataset.detail_files, truncated: true,
    });
    expect(d.repo.markSent).toHaveBeenCalledWith(RUN, { claimGeneration: 1 });
    expect(d.dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: RUN, dataset_key: datasetKey }), 1);
    expect(metrics.assemble).toHaveBeenCalledWith({ kind: 'agent' }, expect.any(Number));
  });

  it('builds with the claimed run and the assembler\'s clock', async () => {
    const build = vi.fn<ReportDatasetBuilder>(async (ctx) => ({ dataset: datasetOf(ctx.run), details: [] }));
    const d = deps({ builders: builders(build) });
    await createReportAssembler(opts, d).drain(() => false);
    expect(build).toHaveBeenCalledWith({ run: expect.objectContaining({ id: RUN }), now: new Date('2026-11-08T10:00:00Z') });
  });

  it('stops when the claim fence refuses the record: nothing sent', async () => {
    const d = deps();
    d.repo.markAssembled.mockResolvedValue(false);
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'claim_lost' });
    expect(d.repo.markSent).not.toHaveBeenCalled();
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('sends nothing when markSent\'s fence refuses', async () => {
    const d = deps();
    d.repo.markSent.mockResolvedValue(null as never);
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'claim_lost' });
    expect(d.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('fails a run claimed more than maxAttempts times, without building it', async () => {
    const build = vi.fn<ReportDatasetBuilder>();
    const d = deps({ builders: builders(build) }, runRecord({ status: 'assembling', claim_generation: 4 }));
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'failed', code: 'assembly_failed' });
    expect(build).not.toHaveBeenCalled();
    expect(d.repo.markFailed).toHaveBeenCalledWith(RUN, 'assembly_failed', { claimGeneration: 4 });
    expect(metrics.runs).toHaveBeenCalledWith({ kind: 'agent', status: 'failed' });
  });

  it('still assembles the claim at the ceiling (claim_generation = maxAttempts)', async () => {
    const d = deps({}, runRecord({ status: 'assembling', claim_generation: 3 }));
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toMatchObject({ outcome: 'sent' });
  });

  it('maps a subject that is gone to subject_unavailable', async () => {
    const d = deps({ builders: builders(async () => { throw new ReportSubjectUnavailableError('campaign deleted'); }) });
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'failed', code: 'subject_unavailable' });
    expect(d.repo.markFailed).toHaveBeenCalledWith(RUN, 'subject_unavailable', { claimGeneration: 1 });
    // An ad hoc run has no subscription to stop.
    expect(d.subscriptions.disable).not.toHaveBeenCalled();
  });

  it('a subscription run whose subject is gone disables its subscription (its failure email is the last)', async () => {
    const gone = builders(async () => { throw new ReportSubjectUnavailableError('campaign deleted'); });
    const d = deps({ builders: gone }, runRecord({ status: 'assembling', subscription_id: SUBSCRIPTION, requested_by: null }));
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'failed', code: 'subject_unavailable' });
    expect(d.subscriptions.disable).toHaveBeenCalledWith(SUBSCRIPTION);

    // Any other failure leaves the schedule alone; a disable that throws still reports the failed run.
    const d2 = deps({ builders: builders(async () => { throw new Error('read failed'); }) }, runRecord({ status: 'assembling', subscription_id: SUBSCRIPTION }));
    await createReportAssembler(opts, d2).drain(() => false);
    expect(d2.subscriptions.disable).not.toHaveBeenCalled();
    const d3 = deps({ builders: gone }, runRecord({ status: 'assembling', subscription_id: SUBSCRIPTION }));
    d3.subscriptions.disable.mockRejectedValue(new Error('db down'));
    expect((await createReportAssembler(opts, d3).drain(() => false))[0]).toMatchObject({ outcome: 'failed', code: 'subject_unavailable' });
  });

  it('a builder refusal the tick\'s probe does not share fails the run and keeps the schedule', async () => {
    // An account report's campaign moved mid-build: the builder refuses, but the account (the
    // subject) is still there, so the next period must still run.
    const refused = builders(async () => { throw new ReportSubjectUnavailableError('a campaign the report covers is no longer in its account'); });
    const d = deps({ builders: refused }, runRecord({ status: 'assembling', kind: 'account', subscription_id: SUBSCRIPTION }));
    d.subject.mockResolvedValue({ available: true, timezone: null });
    expect((await createReportAssembler(opts, d).drain(() => false))[0]).toMatchObject({ outcome: 'failed', code: 'subject_unavailable' });
    expect(d.subject).toHaveBeenCalledWith(expect.objectContaining({ id: RUN, subscription_id: SUBSCRIPTION }));
    expect(d.subscriptions.disable).not.toHaveBeenCalled();

    // A probe that throws leaves the schedule to the tick's own probe.
    const d2 = deps({ builders: refused }, runRecord({ status: 'assembling', subscription_id: SUBSCRIPTION }));
    d2.subject.mockRejectedValue(new Error('db down'));
    expect((await createReportAssembler(opts, d2).drain(() => false))[0]).toMatchObject({ outcome: 'failed', code: 'subject_unavailable' });
    expect(d2.subscriptions.disable).not.toHaveBeenCalled();
  });

  it('a campaign whose zone changed after the run was made fails subject_changed and never stops a schedule', async () => {
    const changed = builders(async () => { throw new ReportZoneChangedError('zone changed'); });
    const d = deps({ builders: changed }, runRecord({ status: 'assembling', subscription_id: SUBSCRIPTION }));
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'failed', code: 'subject_changed' });
    expect(d.repo.markFailed).toHaveBeenCalledWith(RUN, 'subject_changed', { claimGeneration: 1 });
    expect(d.subject).not.toHaveBeenCalled();
    expect(d.subscriptions.disable).not.toHaveBeenCalled();
  });

  it('maps any other failure (a read, an upload) to assembly_failed, never storing the error text', async () => {
    const d = deps({ builders: builders(async () => { throw new Error('relation "secret" does not exist'); }) });
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'failed', code: 'assembly_failed' });
    // The repository writes the code's copy: nothing but the code and the fence reaches it.
    expect(d.repo.markFailed).toHaveBeenCalledWith(RUN, 'assembly_failed', { claimGeneration: 1 });
    expect(JSON.stringify(d.repo.markFailed.mock.calls)).not.toContain('secret');

    const d2 = deps();
    d2.storage.uploadJson.mockRejectedValue(new Error('S3 down'));
    expect((await createReportAssembler(opts, d2).drain(() => false))[0]).toMatchObject({ code: 'assembly_failed' });
  });

  it('fails a build that runs past its wall-clock bound', async () => {
    const d = deps({ builders: builders(() => new Promise(() => {})) });
    const [outcome] = await createReportAssembler({ ...opts, buildTimeoutMs: 20 }, d).drain(() => false);
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'assembly_failed' });
  });

  it('reports a dispatch that throws (the tick re-sends it) and keeps going', async () => {
    const d = deps();
    d.dispatcher.dispatch.mockRejectedValue(new Error('SQS down'));
    const [outcome] = await createReportAssembler(opts, d).drain(() => false);
    expect(outcome).toEqual({ runId: RUN, outcome: 'dispatch_failed', attempt: 1 });
  });

  it('claims with the stale cutoff: now minus the stale window', async () => {
    const d = deps();
    await createReportAssembler({ ...opts, staleAfterMs: 60_000 }, d).drain(() => false);
    expect(d.repo.claimNextQueued).toHaveBeenCalledWith(new Date('2026-11-08T09:59:00Z'));
  });

  it('reclaimOrphans (the first pass after start) reclaims any claim older than the pass itself', async () => {
    const d = deps();
    await createReportAssembler(opts, d).drain(() => false, { reclaimOrphans: true });
    // Not the 30-minute stale cutoff: the pass's own start.
    expect(d.repo.claimNextQueued).toHaveBeenCalledWith(new Date('2026-11-08T10:00:00Z'));
  });
});

describe('the loop', () => {
  it('drains the queue one run at a time and never overlaps a pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const d = deps({
      builders: builders(async (ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return { dataset: datasetOf(ctx.run), details: [] };
      }),
    });
    const queue = [runRecord({ id: RUN, status: 'assembling' }), runRecord({ id: '99999999-9999-4999-8999-999999999999', status: 'assembling' }), null];
    d.repo.claimNextQueued.mockImplementation(async () => queue.shift() ?? null);
    const loop = startReportAssembler(opts, d);
    const first = loop.runPass();
    expect(await loop.runPass()).toBeNull();
    release();
    const outcomes = await first;
    expect(outcomes?.map((o) => o.outcome)).toEqual(['sent', 'sent']);
    expect(maxInFlight).toBe(1);
    await loop.stop();
  });

  it('the first pass after start reclaims orphaned claims; later passes use the stale cutoff', async () => {
    const d = deps();
    const loop = startReportAssembler(opts, d);
    await loop.runPass();
    await loop.runPass();
    expect(d.repo.claimNextQueued.mock.calls[0]![0]).toEqual(new Date('2026-11-08T10:00:00Z'));
    expect(d.repo.claimNextQueued.mock.calls.at(-1)![0]).toEqual(new Date('2026-11-08T09:30:00Z'));
    await loop.stop();
  });

  it('stop gives up on a run in flight after stopWaitMs (the next start reclaims it)', async () => {
    const d = deps({ builders: builders(() => new Promise(() => {})) });
    const loop = startReportAssembler({ ...opts, stopWaitMs: 20 }, d);
    void loop.runPass();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await loop.runPass()).toBeNull();
  });

  it('stop waits for the run in flight and starts no new pass', async () => {
    const d = deps();
    const loop = startReportAssembler(opts, d);
    const pass = loop.runPass();
    await loop.stop();
    await pass;
    expect(await loop.runPass()).toBeNull();
  });
});
