import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  inc: vi.fn(),
  observe: vi.fn(),
  getSignedUrl: vi.fn(),
  uploads: [] as Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>,
  uploadFails: null as Error | null,
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
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mocks.getSignedUrl }));

/** A stand-in for lib-storage's `Upload`: `done()` drains the body as S3 would, then succeeds or fails. */
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn(function (this: { done: () => Promise<unknown> }, options: { params: Record<string, unknown> } & Record<string, unknown>) {
    const { params, ...rest } = options;
    mocks.uploads.push({ params, options: rest });
    this.done = async () => {
      for await (const _chunk of params['Body'] as Readable) { /* drain */ }
      if (mocks.uploadFails) throw mocks.uploadFails;
      return { Key: params['Key'] };
    };
  }),
}));

import {
  attachmentDisposition,
  getPresignedUrl,
  initS3Client,
  UPLOAD_STREAM_PART_BYTES,
  uploadJson,
  uploadStream,
} from '../../../src/storage/s3.js';

/*
 * The S3 helpers the report pipeline uses (docs/reports.md; decision B14: one S3 module): the
 * multipart stream upload of detail files, the JSON write of the dataset, and the presigned
 * download URL that names the file (RFC 6266). Mutation-checked: dropping the body error
 * forwarding makes the failed-source case hang (time out) instead of rejecting; dropping the
 * `ResponseContentDisposition` reds the file-name cases.
 */
describe('S3 helpers for reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploads.length = 0;
    mocks.uploadFails = null;
    initS3Client({ audioBucket: 'test-bucket', region: 'ap-south-1', accessKeyId: 'AKIA', secretAccessKey: 'secret' });
  });

  describe('uploadStream', () => {
    it('uploads the stream as a multipart Upload into the one bucket and resolves to the bytes written', async () => {
      const body = Readable.from([Buffer.alloc(1000, 1), Buffer.alloc(24, 2), Buffer.from('tail')]);
      const bytes = await uploadStream('report-datasets/t/a/r/details-calls.ndjson.gz', body, 'application/gzip');
      expect(bytes).toBe(1028);
      expect(mocks.uploads).toHaveLength(1);
      expect(mocks.uploads[0]!.params).toMatchObject({
        Bucket: 'test-bucket', Key: 'report-datasets/t/a/r/details-calls.ndjson.gz', ContentType: 'application/gzip',
      });
      expect(mocks.uploads[0]!.options).toMatchObject({ partSize: UPLOAD_STREAM_PART_BYTES, queueSize: 2, leavePartsOnError: false });
      expect(UPLOAD_STREAM_PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      expect(mocks.inc).toHaveBeenCalledWith({ operation: 'upload_stream', status: 'success' });
      const [labels, seconds] = mocks.observe.mock.calls[0]!;
      expect(labels).toEqual({ operation: 'upload_stream' });
      expect(seconds).toBeGreaterThanOrEqual(0);
      expect(seconds).toBeLessThan(5);
    });

    it('an empty stream is an empty object of 0 bytes', async () => {
      await expect(uploadStream('k', Readable.from([]), 'application/gzip')).resolves.toBe(0);
    });

    it('a source stream that fails rejects the upload instead of stalling it', async () => {
      const body = new Readable({ read() {} });
      const done = uploadStream('k', body, 'application/gzip');
      body.push(Buffer.from('partial'));
      setImmediate(() => body.destroy(new Error('gzip failed')));
      await expect(done).rejects.toThrow('gzip failed');
      expect(mocks.inc).toHaveBeenCalledWith({ operation: 'upload_stream', status: 'error' });
      expect(mocks.inc).not.toHaveBeenCalledWith({ operation: 'upload_stream', status: 'success' });
      expect(mocks.observe).not.toHaveBeenCalled();
    });

    it('S3 refusing the upload rejects it, counted as an error', async () => {
      mocks.uploadFails = new Error('AccessDenied');
      await expect(uploadStream('k', Readable.from([Buffer.from('x')]), 'application/gzip')).rejects.toThrow('AccessDenied');
      expect(mocks.inc).toHaveBeenCalledWith({ operation: 'upload_stream', status: 'error' });
    });
  });

  describe('uploadJson', () => {
    it('writes the document as UTF-8 JSON and returns its bytes', async () => {
      mocks.send.mockResolvedValue({});
      const bytes = await uploadJson('report-datasets/t/a/r/dataset.json', { name: 'Priyā', n: 1 });
      const input = mocks.send.mock.calls[0]![0].input as { Bucket: string; Key: string; Body: Buffer; ContentType: string };
      expect(input).toMatchObject({ Bucket: 'test-bucket', Key: 'report-datasets/t/a/r/dataset.json', ContentType: 'application/json; charset=utf-8' });
      expect(JSON.parse(input.Body.toString('utf8'))).toEqual({ name: 'Priyā', n: 1 });
      expect(bytes).toBe(input.Body.length);
      expect(bytes).toBe(Buffer.byteLength('{"name":"Priyā","n":1}'));
    });
  });

  describe('getPresignedUrl', () => {
    it('keeps the original signature: the expiry in seconds, no disposition', async () => {
      mocks.getSignedUrl.mockResolvedValue('https://signed');
      await expect(getPresignedUrl('audio/x.mp3', 300)).resolves.toBe('https://signed');
      const [, command, opts] = mocks.getSignedUrl.mock.calls[0]!;
      expect(command.input).toEqual({ Bucket: 'test-bucket', Key: 'audio/x.mp3' });
      expect(opts).toEqual({ expiresIn: 300 });
      await getPresignedUrl('audio/x.mp3');
      expect(mocks.getSignedUrl.mock.calls[1]![2]).toEqual({ expiresIn: 900 });
    });

    it('names the download and sets its content type', async () => {
      mocks.getSignedUrl.mockResolvedValue('https://signed');
      await getPresignedUrl('reports/t/a/r/report.pdf', {
        filename: 'agent-review_priya-s_2026-10-09_2026-11-07.pdf', contentType: 'application/pdf', expiresIn: 300,
      });
      const [, command, opts] = mocks.getSignedUrl.mock.calls[0]!;
      expect(command.input).toEqual({
        Bucket: 'test-bucket',
        Key: 'reports/t/a/r/report.pdf',
        ResponseContentDisposition:
          'attachment; filename="agent-review_priya-s_2026-10-09_2026-11-07.pdf"; filename*=UTF-8\'\'agent-review_priya-s_2026-10-09_2026-11-07.pdf',
        ResponseContentType: 'application/pdf',
      });
      expect(opts).toEqual({ expiresIn: 300 });
    });
  });

  describe('attachmentDisposition (RFC 6266, the CSV exports\' rules)', () => {
    it('a name in another script keeps its own name in filename* and an ASCII fallback', () => {
      expect(attachmentDisposition('रिपोर्ट.xlsx')).toBe(
        "attachment; filename=\"export.xlsx\"; filename*=UTF-8''%E0%A4%B0%E0%A4%BF%E0%A4%AA%E0%A5%8B%E0%A4%B0%E0%A5%8D%E0%A4%9F.xlsx");
    });

    it('quotes and line breaks cannot break the header', () => {
      const value = attachmentDisposition('Q3 "priority"\r\nlist.pdf');
      expect(value).not.toMatch(/[\r\n]/);
      expect(value.startsWith('attachment; filename="Q3 prioritylist.pdf"; filename*=UTF-8\'\'')).toBe(true);
    });

    it('a name with no extension, or an odd one, keeps the whole name', () => {
      expect(attachmentDisposition('report')).toBe("attachment; filename=\"report\"; filename*=UTF-8''report");
      expect(attachmentDisposition('a.b c')).toBe("attachment; filename=\"a.b c\"; filename*=UTF-8''a.b%20c");
    });
  });
});
