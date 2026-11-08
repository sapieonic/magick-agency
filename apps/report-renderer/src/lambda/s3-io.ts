/**
 * {@link RendererIO} over S3 for the Lambda: the default credential chain (the function's role),
 * one bucket (the message's). Writes are a single `PutObject` each (the role holds `s3:PutObject`
 * on `reports/*` and nothing for multipart uploads); the workbook is streamed from its temp file
 * with its length, so it is never buffered whole.
 */
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { RendererIO } from '../io';

/** The slice of `S3Client` used here, so tests can pass a fake. */
export type S3Like = Pick<S3Client, 'send'>;

export function s3IO(client: S3Like, bucket: string): RendererIO {
  const get = async (key: string) => {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) throw new Error(`s3://${bucket}/${key} has no body`);
    return out.Body;
  };
  return {
    async readObject(key) {
      const body = await get(key);
      return Buffer.from(await body.transformToByteArray());
    },
    async readStream(key) {
      const body = await get(key);
      if (body instanceof Readable) return body;
      return Readable.fromWeb(body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0]);
    },
    async writeObject(key, body, contentType, bytes) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentLength: bytes }));
      return { bytes };
    },
  };
}
