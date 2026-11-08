import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

/*
 * `uploadStream` under an abort signal (the report assembler's deadline, docs/reports.md
 * "Pipeline"), through the REAL `@aws-sdk/lib-storage` `Upload` and the real S3 client stack,
 * with only the HTTP handler faked: S3 accepts `CreateMultipartUpload`, then stalls every
 * `UploadPart` until its request is cancelled (S3 slow or throttled). The abort must stop the
 * work, not only the wait: the stalled part request is cancelled, the multipart upload is
 * aborted (`DELETE ?uploadId=…`, not left to the bucket's lifecycle rule) before the promise
 * rejects, and the object is never completed.
 *
 * Mutation-checked: dropping the signal from the client's requests (`clientUnder`) makes the
 * stalled-part case hang to the test timeout; giving the post-abort requests the aborted signal
 * instead of their own bound leaves the multipart upload un-aborted (no DELETE).
 */

interface SeenRequest {
  op: 'create' | 'part' | 'complete' | 'abort' | 'put';
  uploadId?: string | undefined;
  signalAbortedAtSend: boolean;
}

const mocks = vi.hoisted(() => ({
  requests: [] as SeenRequest[],
  inc: vi.fn(),
  observe: vi.fn(),
}));

vi.mock('@magick-agency/observability/metrics/agency', () => ({
  s3OperationsTotal: { inc: mocks.inc },
  s3OperationDurationSeconds: { observe: mocks.observe },
}));

type FakeRequest = { method: string; query?: Record<string, string | string[] | null> };
type FakeOptions = { abortSignal?: AbortSignal };

/** S3 over HTTP, faked at the handler: every `UploadPart` stalls until its request is cancelled. */
const fakeHandler = {
  metadata: { handlerProtocol: 'http/1.1' },
  updateHttpClientConfig: () => {},
  httpHandlerConfigs: () => ({}),
  destroy: () => {},
  async handle(request: FakeRequest, { abortSignal }: FakeOptions = {}) {
    const query = request.query ?? {};
    const uploadId = typeof query['uploadId'] === 'string' ? query['uploadId'] : undefined;
    const op: SeenRequest['op'] =
      'uploads' in query ? 'create'
        : query['partNumber'] !== undefined ? 'part'
          : request.method === 'DELETE' && uploadId ? 'abort'
            : request.method === 'POST' && uploadId ? 'complete'
              : 'put';
    mocks.requests.push({ op, uploadId, signalAbortedAtSend: abortSignal?.aborted ?? false });
    const respond = (statusCode: number, body = '', headers: Record<string, string> = {}) => ({
      response: { statusCode, headers: { 'content-type': 'application/xml', ...headers }, body: Readable.from([Buffer.from(body)]) },
    });
    if (abortSignal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    switch (op) {
      case 'create':
        return respond(200, '<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>k</Key><UploadId>U1</UploadId></InitiateMultipartUploadResult>');
      case 'part':
        return new Promise((_, reject) => {
          abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })));
        });
      case 'abort':
        return respond(204);
      default:
        return respond(200, '', { etag: '"e"' });
    }
  },
};

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  class S3Client extends real.S3Client {
    constructor(config: ConstructorParameters<typeof real.S3Client>[0]) {
      super({ ...config, requestHandler: fakeHandler as never, maxAttempts: 1 });
    }
  }
  return { ...real, S3Client };
});

import { initS3Client, uploadStream, UPLOAD_STREAM_PART_BYTES } from '../../../src/storage/s3.js';

describe('uploadStream under an abort signal (real lib-storage, faked HTTP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requests.length = 0;
    initS3Client({ audioBucket: 'test-bucket', region: 'ap-south-1', accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('a part stalled on S3 is cancelled and the multipart upload aborted before the upload rejects', async () => {
    // More than one part, and the stream left open: part 1 goes out as a multipart part and stalls.
    const body = new Readable({ read() {} });
    body.push(Buffer.alloc(UPLOAD_STREAM_PART_BYTES + 1024, 7));
    const deadline = new AbortController();
    const upload = uploadStream('report-datasets/t/a/r/details-attempts.ndjson.gz', body, 'application/gzip', deadline.signal);
    upload.catch(() => undefined);

    await vi.waitFor(() => { expect(mocks.requests.map((r) => r.op)).toEqual(['create', 'part']); });
    deadline.abort(new Error('report build timed out after 50ms'));

    await expect(upload).rejects.toThrow();
    const ops = mocks.requests.map((r) => r.op);
    // Aborted, never completed; the abort went out live (its own bound), not under the fired signal.
    expect(ops).toContain('abort');
    expect(ops).not.toContain('complete');
    const abort = mocks.requests.find((r) => r.op === 'abort')!;
    expect(abort).toMatchObject({ uploadId: 'U1', signalAbortedAtSend: false });
    expect(body.destroyed).toBe(true);
    expect(mocks.inc).toHaveBeenCalledWith({ operation: 'upload_stream', status: 'error' });
  });

  it('an abort before any part goes out sends nothing and never completes a truncated object', async () => {
    const body = new Readable({ read() {} });
    body.push(Buffer.from('a few rows'));
    const deadline = new AbortController();
    const upload = uploadStream('k', body, 'application/gzip', deadline.signal);
    upload.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    deadline.abort(new Error('deadline'));
    await expect(upload).rejects.toThrow('deadline');
    expect(mocks.requests).toEqual([]);
  });

  it('an already-aborted signal refuses at once', async () => {
    const deadline = new AbortController();
    deadline.abort(new Error('deadline'));
    await expect(uploadStream('k', Readable.from([Buffer.from('x')]), 'application/gzip', deadline.signal)).rejects.toThrow('deadline');
    expect(mocks.requests).toEqual([]);
  });

  it('without a signal, a body that ends is uploaded as one object', async () => {
    await expect(uploadStream('k', Readable.from([Buffer.from('rows')]), 'application/gzip')).resolves.toBe(4);
    expect(mocks.requests.map((r) => r.op)).toEqual(['put']);
  });
});
