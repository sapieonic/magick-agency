// PORT NOTE (magick-agency): ported from magic-voice-core/src/storage/s3.ts@4850d1d9.
// Only change: logger/withSpan import specifiers (now @magick-agency/observability).

import type { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createChildLogger, withSpan } from '@magick-agency/observability';
import { s3OperationsTotal, s3OperationDurationSeconds } from '@magick-agency/observability/metrics/agency';

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

export async function uploadFile(key: string, body: Buffer, contentType: string): Promise<void> {
  return withSpan('s3.upload', {
    'storage.key': key,
    'storage.content_type': contentType,
  }, async () => {
    const client = getClient();
    await client.send(new PutObjectCommand({
      Bucket: audioBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
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

export async function getPresignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
  return withSpan('s3.get_presigned_url', {
    'storage.key': key,
  }, async () => {
    const client = getClient();
    const url = await getSignedUrl(client, new GetObjectCommand({
      Bucket: audioBucket,
      Key: key,
    }), { expiresIn: expiresInSeconds });
    return url;
  });
}

/*
 * PORT NOTE (magick-agency, lane B2, decision B14): everything above is core's `src/storage/s3.ts`
 * (lane C). The two functions below are master's `getFileStream` (`magick-master
 * src/storage/s3.ts:78-98`@a1f0756a) and `headFile` (`:115-130`), the two the CSV ingest uses that
 * core's module lacks, appended with their doc comments. Changes, all forced by the one-module
 * rule: `getS3Client()` → `getClient()` and `s3Bucket!` → `audioBucket` (core's names for the same
 * client and bucket; the bucket is `config.s3.audioBucket`), and `headFile`'s
 * `s3OperationDurationSeconds.startTimer(...)`/`stopTimer()` becomes a `process.hrtime` measurement
 * `observe`d on the same histogram (agency's instrument wrappers have no `startTimer`). The two
 * metrics are declared in `packages/observability/src/metrics/agency.ts` with master's names and
 * buckets.
 */

/**
 * Open an S3 object as a stream, without buffering it.
 *
 * Core's module has no buffering read of this shape: `getFile` concatenates the whole object,
 * which is unusable for an agency roster — a 1M-row CSV is hundreds of megabytes and this service
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
