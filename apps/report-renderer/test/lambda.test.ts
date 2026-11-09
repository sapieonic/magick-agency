/**
 * The Lambda handler with a fake S3 client and a fake fetch (a final 4xx is neither retried nor
 * redelivered; each try carries a timeout signal): the callback is signed as the
 * contract says (and verifies), a failed POST is retried with backoff, an undeliverable callback
 * is a batch item failure, a render failure is not, a record past its `superseded_after` is
 * dropped unrendered. Plus the layer resolution of
 * `@sparticuz/chromium`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  REPORT_SIGNATURE_HEADER,
  REPORT_TIMESTAMP_HEADER,
  reportSignaturePayload,
  type ReportRenderCallback,
  type ReportRenderMessage,
} from '@magick-agency/contracts/reports';
import { createHandler, type HandlerDeps } from '../src/lambda';
import { CALLBACK_BACKOFF_MS } from '../src/lambda/callback';
import { chromiumSpecifier, loadSparticuzChromium } from '../src/lambda/chromium';
import { verifyCallbackSignature } from '../src/signature';
import { campaignFixture } from './fixtures/campaign';

const SECRET = 'a-callback-secret-of-at-least-32-characters';
const NOW = 1_794_000_000;

function fakeS3(objects: Map<string, Buffer>) {
  const puts: Array<{ Bucket: string; Key: string; ContentType: string; ContentLength: number; bytes: number }> = [];
  return {
    puts,
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        const body = objects.get(command.input.Key!);
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        const stream = Readable.from([body]) as Readable & { transformToByteArray: () => Promise<Uint8Array> };
        stream.transformToByteArray = async () => new Uint8Array(body);
        return { Body: stream };
      }
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(input.Body)) chunks.push(input.Body);
        else for await (const c of input.Body as Readable) chunks.push(Buffer.from(c as Buffer));
        const body = Buffer.concat(chunks);
        objects.set(input.Key!, body);
        puts.push({ Bucket: input.Bucket!, Key: input.Key!, ContentType: input.ContentType!, ContentLength: input.ContentLength!, bytes: body.length });
        return {};
      }
      throw new Error(`unexpected command ${String((command as object).constructor.name)}`);
    },
  };
}

function setup(statuses: Array<number | Error>, opts: { secret?: string; dataset?: 'ok' | 'v2'; supersededAfter?: string } = {}) {
  const { dataset, details } = campaignFixture();
  const objects = new Map<string, Buffer>(details);
  const datasetKey = `report-datasets/t/a/${dataset.run_id}/dataset.json`;
  objects.set(datasetKey, Buffer.from(JSON.stringify(opts.dataset === 'v2' ? { ...dataset, dataset_version: 2 } : dataset)));
  const s3 = fakeS3(objects);
  const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const inits: Array<{ signal?: AbortSignal }> = [];
  const sleeps: number[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const queue = [...statuses];
  const deps: HandlerDeps = {
    s3: s3 as unknown as HandlerDeps['s3'],
    secret: 'secret' in opts ? opts.secret : SECRET,
    launch: () => Promise.reject(new Error('no browser in this test')),
    log: (l) => logs.push(l),
    fetch: async (url, init) => {
      posts.push({ url, headers: init.headers, body: init.body });
      inits.push(init);
      const next = queue.shift() ?? 200;
      if (next instanceof Error) throw next;
      return { status: next };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
  };
  const message: ReportRenderMessage = {
    run_id: dataset.run_id,
    attempt: 1,
    dataset_version: 1,
    bucket: 'magick-agency-reports',
    dataset_key: datasetKey,
    output_prefix: `reports/t/a/${dataset.run_id}/`,
    formats: ['xlsx'],
    callback_url: 'https://agency.example.test/webhooks/reports/rendered',
    ...(opts.supersededAfter !== undefined ? { superseded_after: opts.supersededAfter } : {}),
  };
  const event = { Records: [{ messageId: 'm-1', body: JSON.stringify(message), attributes: { ApproximateReceiveCount: '1' } }] } as unknown as SQSEvent;
  return { handler: createHandler(deps), event, posts, inits, sleeps, logs, s3, message, dataset };
}

describe('Lambda handler', () => {
  it('renders, writes to the message’s bucket with one PutObject, and POSTs a verifiable signed callback', async () => {
    const { handler, event, posts, s3, message, logs } = setup([200]);
    const res = await handler(event);
    expect(res.batchItemFailures).toEqual([]);
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0]).toMatchObject({ Bucket: 'magick-agency-reports', Key: `${message.output_prefix}report.xlsx` });
    expect(s3.puts[0]!.ContentLength).toBe(s3.puts[0]!.bytes);

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe(message.callback_url);
    expect(post.headers[REPORT_TIMESTAMP_HEADER]).toBe(String(NOW));
    const expected = createHmac('sha256', SECRET).update(reportSignaturePayload(NOW, post.body)).digest('hex');
    expect(post.headers[REPORT_SIGNATURE_HEADER]).toBe(expected);
    expect(verifyCallbackSignature(SECRET, post.body, String(NOW), post.headers[REPORT_SIGNATURE_HEADER]!)).toBe(true);
    expect(verifyCallbackSignature('another-secret-entirely-of-32-chars!!', post.body, String(NOW), post.headers[REPORT_SIGNATURE_HEADER]!)).toBe(false);

    const cb = JSON.parse(post.body) as ReportRenderCallback;
    expect(cb).toMatchObject({ run_id: message.run_id, attempt: 1, status: 'rendered', error: null });
    expect(cb.files[0]).toMatchObject({ format: 'xlsx', key: `${message.output_prefix}report.xlsx`, bytes: s3.puts[0]!.bytes });
    // Logs carry ids and timings, never dataset contents.
    const logged = JSON.stringify(logs);
    expect(logged).toContain(message.run_id);
    expect(logged).not.toContain('Arjun Mehta');
    expect(logged).not.toContain('+91');
  });

  it('retries a failed POST with backoff, signing each try afresh', async () => {
    const { handler, event, posts, sleeps } = setup([503, new Error('ECONNRESET'), 204]);
    const res = await handler(event);
    expect(res.batchItemFailures).toEqual([]);
    expect(posts).toHaveLength(3);
    expect(sleeps).toEqual(CALLBACK_BACKOFF_MS);
    for (const p of posts) expect(verifyCallbackSignature(SECRET, p.body, p.headers[REPORT_TIMESTAMP_HEADER]!, p.headers[REPORT_SIGNATURE_HEADER]!)).toBe(true);
  });

  it('reports the record as a batch item failure when the callback cannot be delivered', async () => {
    const { handler, event, posts } = setup([500, 502, 503]);
    const res = await handler(event);
    expect(posts).toHaveLength(3);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
  });

  it('a final refusal (400, 401, 403, 404) is not retried and not redelivered; 408 and 429 are retried', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { handler, event, posts, logs } = setup([status]);
      const res = await handler(event);
      expect(posts, String(status)).toHaveLength(1);
      expect(res.batchItemFailures, String(status)).toEqual([]);
      expect(logs).toContainEqual(expect.objectContaining({ event: 'record.callback_refused', status }));
    }
    const { handler, event, posts } = setup([408, 429, 204]);
    expect((await handler(event)).batchItemFailures).toEqual([]);
    expect(posts).toHaveLength(3);
  });

  it('bounds each callback try with a timeout signal', async () => {
    const { handler, event, inits } = setup([204]);
    await handler(event);
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('calls back a render failure and does not ask SQS to retry it', async () => {
    const { handler, event, posts, s3 } = setup([200], { dataset: 'v2' });
    const res = await handler(event);
    expect(res.batchItemFailures).toEqual([]);
    expect(s3.puts).toHaveLength(0);
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ status: 'failed', error: { code: 'dataset_version_unsupported' } });
  });

  it('drops a record received after its superseded_after: no read, no render, no callback, no redelivery', async () => {
    const past = new Date(NOW * 1000 - 1_000).toISOString();
    const { handler, event, posts, s3, logs, message } = setup([204], { supersededAfter: past });
    const res = await handler(event);
    expect(res.batchItemFailures).toEqual([]);
    expect(s3.puts).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'record.superseded', run_id: message.run_id, attempt: 1, superseded_after: past }));
  });

  it('renders a record still inside its superseded_after, and one without (or with an unreadable) deadline', async () => {
    for (const supersededAfter of [new Date(NOW * 1000 + 60_000).toISOString(), undefined, 'not a date']) {
      const { handler, event, posts, s3 } = setup([204], supersededAfter === undefined ? {} : { supersededAfter });
      expect((await handler(event)).batchItemFailures, String(supersededAfter)).toEqual([]);
      expect(s3.puts, String(supersededAfter)).toHaveLength(1);
      expect(posts, String(supersededAfter)).toHaveLength(1);
    }
  });

  it('fails the record without a secret, and on a body that is not a message', async () => {
    expect((await setup([200], { secret: undefined }).handler(setup([200]).event)).batchItemFailures).toHaveLength(1);
    const { handler } = setup([200]);
    const res = await handler({ Records: [{ messageId: 'm-2', body: '{not json' }] } as unknown as SQSEvent);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-2' }]);
  });
});

describe('@sparticuz/chromium resolution', () => {
  it('imports the copy in the layer directory by file URL when the layer has it', async () => {
    const layer = mkdtempSync(join(tmpdir(), 'layer-'));
    const pkg = join(layer, '@sparticuz', 'chromium');
    mkdirSync(join(pkg, 'build'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@sparticuz/chromium', type: 'module', exports: { '.': { default: './build/index.js' } } }));
    writeFileSync(join(pkg, 'build', 'index.js'), "export default { args: ['--from-layer'], executablePath: async () => '/tmp/chromium' };\n");
    const spec = chromiumSpecifier(`${layer}/`);
    expect(spec).toBe(pathToFileURL(join(pkg, 'build', 'index.js')).href);
    const chromium = await loadSparticuzChromium({ layerDir: layer, importer: (s) => import(s) });
    expect(chromium.args).toEqual(['--from-layer']);
    expect(await chromium.executablePath()).toBe('/tmp/chromium');
  });

  it('falls back to the bare name outside Lambda', async () => {
    expect(chromiumSpecifier('/nonexistent/layer/')).toBe('@sparticuz/chromium');
    const seen: string[] = [];
    await loadSparticuzChromium({ layerDir: '/nonexistent/layer/', importer: async (s) => (seen.push(s), { default: { args: [], executablePath: async () => '' } }) });
    expect(seen).toEqual(['@sparticuz/chromium']);
  });
});
