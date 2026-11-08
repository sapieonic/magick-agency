import { Transform, type Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createChildLogger, withSpan } from '@magick-agency/observability';
import { s3OperationsTotal, s3OperationDurationSeconds } from '@magick-agency/observability/metrics/agency';
import { attachmentHeader } from '../api/routes/helpers/csv-attachment.js';

const log = createChildLogger({ component: 's3-storage' });

let s3Client: S3Client | null = null;
let audioBucket = '';

export interface S3Config {
  audioBucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function initS3Client(config: S3Config): void {
  audioBucket = config.audioBucket;
  s3Client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  log.info({ bucket: audioBucket, region: config.region }, 'S3 client initialized');
}

function getClient(): S3Client {
  if (!s3Client) throw new Error('S3 client not initialized. Call initS3Client() first.');
  return s3Client;
}

/** Write one object. `signal` cancels the request (the report assembler's deadline). */
export async function uploadFile(key: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
  return withSpan('s3.upload', {
    'storage.key': key,
    'storage.content_type': contentType,
  }, async () => {
    const client = getClient();
    signal?.throwIfAborted();
    await client.send(new PutObjectCommand({
      Bucket: audioBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }), signal ? { abortSignal: signal } : {});
    log.info({ key, contentType, size: body.length }, 'File uploaded to S3');
  });
}

export async function deleteFile(key: string): Promise<void> {
  return withSpan('s3.delete', {
    'storage.key': key,
  }, async () => {
    const client = getClient();
    await client.send(new DeleteObjectCommand({
      Bucket: audioBucket,
      Key: key,
    }));
    log.info({ key }, 'File deleted from S3');
  });
}

/**
 * Delete EVERY object under a key prefix (paginated). Used by the knowledge-base
 * hard-purge to reclaim all of a document's/folder's version objects at once —
 * robust to the object-naming scheme and to superseded versions no row still points
 * at (a single stored s3_key per row can't enumerate them). Throws if any page
 * delete fails, so a caller can treat the purge as retryable.
 */
export async function deleteByPrefix(prefix: string): Promise<number> {
  return withSpan('s3.delete_by_prefix', { 'storage.key': prefix }, async () => {
    const client = getClient();
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: audioBucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (objects.length > 0) {
        const res = await client.send(
          new DeleteObjectsCommand({ Bucket: audioBucket, Delete: { Objects: objects, Quiet: true } }),
        );
        if (res.Errors && res.Errors.length > 0) {
          throw new Error(`Failed to delete ${res.Errors.length} object(s) under prefix ${prefix}`);
        }
        deleted += objects.length;
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    log.info({ prefix, deleted }, 'Deleted objects by prefix from S3');
    return deleted;
  });
}

export async function getFile(key: string): Promise<Buffer> {
  return withSpan('s3.get', {
    'storage.key': key,
  }, async () => {
    const client = getClient();
    const res = await client.send(new GetObjectCommand({
      Bucket: audioBucket,
      Key: key,
    }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  });
}

/** What a presigned GET may set on the response besides the expiry. */
export interface PresignOptions {
  /** Seconds the URL is valid; default 900. */
  expiresIn?: number;
  /**
   * Served as `Content-Disposition: attachment` with this name (RFC 6266: an ASCII `filename=`
   * fallback plus the UTF-8 `filename*=`), so the browser saves the file under it whatever the
   * object's key is. The extension is the part after the last `.`.
   */
  filename?: string;
  /** Served as the response `Content-Type` (overriding the object's own). */
  contentType?: string;
}

/**
 * A presigned GET for one object of the bucket. The second argument is the expiry in seconds
 * (the original signature) or {@link PresignOptions}; the report downloads pass a file name and
 * content type, so the URL downloads as `agent-review_priya-s_2026-10-09_2026-11-07.pdf`.
 */
export async function getPresignedUrl(key: string, options: number | PresignOptions = {}): Promise<string> {
  const opts: PresignOptions = typeof options === 'number' ? { expiresIn: options } : options;
  return withSpan('s3.get_presigned_url', {
    'storage.key': key,
  }, async () => {
    const client = getClient();
    const url = await getSignedUrl(client, new GetObjectCommand({
      Bucket: audioBucket,
      Key: key,
      ...(opts.filename !== undefined ? { ResponseContentDisposition: attachmentDisposition(opts.filename) } : {}),
      ...(opts.contentType !== undefined ? { ResponseContentType: opts.contentType } : {}),
    }), { expiresIn: opts.expiresIn ?? 900 });
    return url;
  });
}

/** `Content-Disposition: attachment` for a full file name (extension after the last `.`). */
export function attachmentDisposition(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  // Only an ASCII alphanumeric extension is split off; anything else stays part of the name.
  return /^[A-Za-z0-9]{1,10}$/.test(ext)
    ? attachmentHeader(filename.slice(0, dot), ext)
    : attachmentHeader(filename, '');
}

/** Multipart part size for {@link uploadStream}: 8 MiB (S3's minimum is 5 MiB, at most 10,000 parts). */
export const UPLOAD_STREAM_PART_BYTES = 8 * 1024 * 1024;
/** Parts in flight at once for one {@link uploadStream}: peak memory is about this × the part size. */
export const UPLOAD_STREAM_QUEUE_SIZE = 2;

/**
 * How long the requests an aborted {@link uploadStream} still sends (in practice its
 * `AbortMultipartUpload`) may take before they are given up on, and the bucket's lifecycle rule
 * (incomplete multipart uploads aborted after 7 days, `aws/terraform/s3.tf`) is left to clear it.
 */
export const UPLOAD_STREAM_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * `client` with `signal` on every request it sends while the signal is live, so an abort cancels
 * the requests in flight (an `UploadPart` stalled on a slow or throttled S3). A request sent
 * after the abort (lib-storage's `AbortMultipartUpload`, which must still go out) gets its own
 * {@link UPLOAD_STREAM_CLEANUP_TIMEOUT_MS} bound instead. lib-storage calls `send(command)` with
 * no options of its own.
 */
function clientUnder(client: S3Client, signal: AbortSignal): S3Client {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'send') return Reflect.get(target, prop, target) as unknown;
      return (command: Parameters<S3Client['send']>[0]) => target.send(command, {
        abortSignal: signal.aborted ? AbortSignal.timeout(UPLOAD_STREAM_CLEANUP_TIMEOUT_MS) : signal,
      });
    },
  });
}

/**
 * Upload a stream of unknown length without buffering it whole (the report assembler's gzipped
 * detail files, up to `AGENCY_REPORTS_MAX_DETAIL_ROWS` rows each): a multipart upload through
 * `@aws-sdk/lib-storage`'s `Upload` (one `PutObject` when the body fits in one part). Resolves to
 * the bytes written once S3 has the whole object; rejects, with the multipart upload aborted,
 * when the body stream errors or S3 refuses. Counted as `s3_operations_total{operation=
 * "upload_stream"}` and timed in `s3_operation_duration_seconds`.
 *
 * `signal` (the report assembler's deadline) stops the upload rather than only the wait for it:
 * the requests in flight are cancelled, the body is destroyed with the abort's reason (so no
 * part is read after it, and a truncated body is never completed as the object), and the
 * promise rejects once lib-storage has sent `AbortMultipartUpload` for the parts already
 * stored, each request after the abort bounded by {@link UPLOAD_STREAM_CLEANUP_TIMEOUT_MS}.
 */
export async function uploadStream(key: string, body: Readable, contentType: string, signal?: AbortSignal): Promise<number> {
  return withSpan('s3.upload_stream', { 's3.key': key, 'storage.content_type': contentType }, async (span) => {
    const startedAt = process.hrtime.bigint();
    signal?.throwIfAborted();
    const client = signal ? clientUnder(getClient(), signal) : getClient();
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    // `pipe` does not forward errors: a failed source must fail the upload, not stall it.
    body.on('error', (err) => counter.destroy(err));
    body.pipe(counter);
    const onAbort = () => counter.destroy(signal?.reason instanceof Error ? signal.reason : new Error('upload aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const upload = new Upload({
      client,
      params: { Bucket: audioBucket, Key: key, Body: counter, ContentType: contentType },
      partSize: UPLOAD_STREAM_PART_BYTES,
      queueSize: UPLOAD_STREAM_QUEUE_SIZE,
      leavePartsOnError: false,
    });
    try {
      await upload.done();
    } catch (err) {
      s3OperationsTotal.inc({ operation: 'upload_stream', status: 'error' });
      body.unpipe(counter);
      body.destroy();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    s3OperationsTotal.inc({ operation: 'upload_stream', status: 'success' });
    s3OperationDurationSeconds.observe({ operation: 'upload_stream' }, Number(process.hrtime.bigint() - startedAt) / 1e9);
    span.setAttribute('s3.size_bytes', bytes);
    log.info({ key, contentType, size: bytes }, 'Stream uploaded to S3');
    return bytes;
  });
}

/** Write a JSON document (the report `dataset.json`): `application/json`, UTF-8. Returns its bytes. `signal` as {@link uploadFile}. */
export async function uploadJson(key: string, value: unknown, signal?: AbortSignal): Promise<number> {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  await uploadFile(key, body, 'application/json; charset=utf-8', signal);
  return body.length;
}

/*
 * The two functions below are the ones the CSV ingest uses (decision B14). They use the same
 * client and bucket as the rest of this module (`getClient()`, `config.s3.audioBucket`).
 * `headFile` measures with `process.hrtime` and `observe`s the histogram, because the
 * instrument wrappers have no `startTimer`. The metrics are declared in
 * `packages/observability/src/metrics/agency.ts`.
 */

/**
 * Open an S3 object as a stream, without buffering it.
 *
 * `getFile` concatenates the whole object, which is unusable for an agency roster — a 1M-row CSV is hundreds of megabytes and this service
 * runs one process. The agency ingest pipes this straight into a streaming parser, so peak memory
 * is a few chunks rather than the file.
 *
 * Also returns `contentLength`, which is what makes the ingest's progress bar determinate:
 * bytes-read over bytes-total is the only honest completion fraction when the row count is
 * unknown until the file has been read.
 */
export async function getFileStream(key: string): Promise<{ body: Readable; contentLength?: number }> {
  return withSpan('s3.get_stream', { 's3.key': key }, async (span) => {
    const client = getClient();
    const response = await client.send(new GetObjectCommand({
      Bucket: audioBucket,
      Key: key,
    }));
    if (!response.Body) throw new Error(`Empty response body for S3 key: ${key}`);
    s3OperationsTotal.inc({ operation: 'get_stream', status: 'success' });
    if (response.ContentLength !== undefined) {
      span.setAttribute('s3.size_bytes', response.ContentLength);
    }
    return {
      body: response.Body as Readable,
      ...(response.ContentLength !== undefined ? { contentLength: response.ContentLength } : {}),
    };
  });
}

/**
 * Prove an object exists and is readable, WITHOUT opening its body.
 *
 * ── Why this is not `getFileStream` ─────────────────────────────────────────
 * The agency roster replace has to rule out a missing or unreadable file
 * *before* it retires the campaign's existing contacts — a roster must never be
 * destroyed for a file that could never have been read. `getFileStream` proves
 * the same thing, but it proves it by opening the response body, and the
 * supersede round trip that follows can take up to four attempts of 30s: an S3
 * body left unread across it is a live HTTP response nothing is draining, which
 * S3 or any intermediary is free to close, turning a survivable "file missing"
 * into a torn stream *after* the destructive step. A HEAD carries no body, so
 * there is nothing to hold open.
 *
 * Returns `contentLength` because callers that want the progress-bar total can
 * take it from here; the ingest deliberately does not, so the size it records
 * comes from the same open that feeds the parser.
 */
export async function headFile(key: string): Promise<{ contentLength?: number }> {
  return withSpan('s3.head', { 's3.key': key }, async (span) => {
    const startedAt = process.hrtime.bigint();
    const client = getClient();
    const response = await client.send(new HeadObjectCommand({
      Bucket: audioBucket,
      Key: key,
    }));
    s3OperationsTotal.inc({ operation: 'head', status: 'success' });
    s3OperationDurationSeconds.observe({ operation: 'head' }, Number(process.hrtime.bigint() - startedAt) / 1e9);
    if (response.ContentLength !== undefined) {
      span.setAttribute('s3.size_bytes', response.ContentLength);
    }
    return response.ContentLength !== undefined ? { contentLength: response.ContentLength } : {};
  });
}
