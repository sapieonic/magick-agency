import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  inc: vi.fn(),
  observe: vi.fn(),
}));

vi.mock('@magick-agency/observability/metrics/agency', () => ({
  s3OperationsTotal: { inc: mocks.inc },
  s3OperationDurationSeconds: { observe: mocks.observe },
}));

vi.mock('@aws-sdk/client-s3', () => {
  const S3Client = vi.fn(function (this: { send: typeof mocks.send }) {
    this.send = mocks.send;
  });
  const cmd = () => vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  });
  return {
    S3Client, PutObjectCommand: cmd(), DeleteObjectCommand: cmd(), DeleteObjectsCommand: cmd(),
    ListObjectsV2Command: cmd(), GetObjectCommand: cmd(), HeadObjectCommand: cmd(),
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

import { initS3Client, headFile, getFileStream } from '../../../src/storage/s3.js';

/*
 * PORT NOTE (magick-agency, lane B2, decision B14): ported from master
 * test/unit/storage/s3.test.ts@a1f0756a, the three `headFile` cases (verbatim bodies; only the
 * `initS3Client` argument changes to core's `{ audioBucket, … }` shape and the import is core's
 * one module). Master's other 4 cases (not-initialized, upload, delete, getFileBuffer) cover
 * functions that are core's, not appended by B2, and are not ported here. NEW, no master twin:
 * the two `getFileStream` cases and the bucket/key assertion (master had no test for
 * `getFileStream`).
 */
describe('S3 reads used by the agency CSV ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initS3Client({ audioBucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  it('heads an object without opening its body', async () => {
    // The agency roster replace needs to prove a file exists BEFORE it retires a
    // campaign's contacts, and it must not hold an S3 body open across that
    // supersede — so this returns metadata and no stream.
    mocks.send.mockResolvedValue({ ContentLength: 4321 });
    await expect(headFile('agency-ingest/t/u/roster.csv')).resolves.toEqual({ contentLength: 4321 });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]![0].input).toEqual({ Bucket: 'test-bucket', Key: 'agency-ingest/t/u/roster.csv' });
  });

  it('propagates a missing object rather than reporting an empty one', async () => {
    // A swallowed 404 here would let the replace proceed to the supersede, which
    // is the whole failure this probe exists to prevent.
    mocks.send.mockRejectedValue(new Error('NoSuchKey'));
    await expect(headFile('agency-ingest/t/u/missing.csv')).rejects.toThrow('NoSuchKey');
  });

  it('omits contentLength when S3 does not report one', async () => {
    // Absent, not zero: a caller sizing a progress bar must be able to tell "no
    // size" from "an empty file".
    mocks.send.mockResolvedValue({});
    await expect(headFile('agency-ingest/t/u/roster.csv')).resolves.toEqual({});
  });

  // The modified line in `headFile` (master's `startTimer`/`stopTimer` → hrtime + `observe`) and the
  // two counters have no master test; these pin master's metric names' labels and the unit (seconds).
  it('headFile counts the operation with master\'s labels and observes its duration in seconds', async () => {
    mocks.send.mockResolvedValue({ ContentLength: 1 });

    await headFile('k');

    expect(mocks.inc).toHaveBeenCalledWith({ operation: 'head', status: 'success' });
    expect(mocks.observe).toHaveBeenCalledTimes(1);
    const [labels, seconds] = mocks.observe.mock.calls[0]!;
    expect(labels).toEqual({ operation: 'head' });
    expect(typeof seconds).toBe('number');
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThan(5); // seconds, not nanoseconds or milliseconds
  });

  it('a failed headFile records neither a success count nor a duration', async () => {
    mocks.send.mockRejectedValue(new Error('NoSuchKey'));
    await expect(headFile('k')).rejects.toThrow();
    expect(mocks.inc).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it('getFileStream counts a get_stream success with master\'s labels', async () => {
    mocks.send.mockResolvedValue({ Body: Readable.from([]) });
    await getFileStream('k');
    expect(mocks.inc).toHaveBeenCalledWith({ operation: 'get_stream', status: 'success' });
  });

  it('getFileStream returns the body unbuffered with its content length, from the one bucket', async () => {
    const body = Readable.from(['a,b\n']);
    mocks.send.mockResolvedValue({ Body: body, ContentLength: 4 });

    const result = await getFileStream('agency-ingest/t/u/roster.csv');

    expect(result.body).toBe(body);
    expect(result.contentLength).toBe(4);
    expect(mocks.send.mock.calls[0]![0].input).toEqual({ Bucket: 'test-bucket', Key: 'agency-ingest/t/u/roster.csv' });
  });

  it('getFileStream omits contentLength when S3 does not report one', async () => {
    mocks.send.mockResolvedValue({ Body: Readable.from([]) });
    expect('contentLength' in (await getFileStream('k'))).toBe(false);
  });

  it('getFileStream refuses an empty response body', async () => {
    mocks.send.mockResolvedValue({});
    await expect(getFileStream('agency-ingest/t/u/roster.csv')).rejects.toThrow('Empty response body for S3 key');
  });
});
