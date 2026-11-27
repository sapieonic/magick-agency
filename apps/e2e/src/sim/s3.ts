/**
 * A minimal in-memory S3 for the server's AWS SDK (`AWS_ENDPOINT_URL_S3` points here; an IP
 * endpoint makes the SDK address buckets path-style: `/s3/<bucket>/<key>`).
 *
 * Covers what `apps/server/src/storage/s3.ts` uses: PutObject, GetObject (also through a
 * presigned URL, whose signature is not checked), HeadObject, DeleteObject, DeleteObjects,
 * ListObjectsV2 and the multipart upload `@aws-sdk/lib-storage` falls back to for large bodies.
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

interface StoredObject {
  body: Buffer;
  contentType: string;
  lastModified: Date;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>(); // `${bucket}/${key}`
  private readonly uploads = new Map<string, Map<number, Buffer>>();

  reset(): void {
    this.objects.clear();
    this.uploads.clear();
  }

  keys(bucket: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/`)).map((k) => k.slice(bucket.length + 1));
  }

  handle(method: string, url: URL, body: Buffer, headers: Record<string, string | string[] | undefined>, res: ServerResponse): void {
    // /s3/<bucket>/<key...>
    const rest = url.pathname.replace(/^\/s3\/?/, '');
    const slash = rest.indexOf('/');
    const bucket = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const key = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1));
    const q = url.searchParams;
    const id = `${bucket}/${key}`;
    const xml = (status: number, payload: string) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${payload}`);
    };
    const notFound = () => xml(404, `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${xmlEscape(key)}</Key></Error>`);

    if (!key) {
      if (method === 'GET') {
        const prefix = q.get('prefix') ?? '';
        const contents = this.keys(bucket).filter((k) => k.startsWith(prefix)).map((k) => {
          const o = this.objects.get(`${bucket}/${k}`)!;
          return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><Size>${o.body.length}</Size><ETag>"e2e"</ETag><StorageClass>STANDARD</StorageClass></Contents>`;
        });
        xml(200, `<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join('')}</ListBucketResult>`);
        return;
      }
      if (method === 'POST' && q.has('delete')) {
        const keys = [...body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]!);
        for (const k of keys) this.objects.delete(`${bucket}/${k}`);
        xml(200, `<DeleteResult>${keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('')}</DeleteResult>`);
        return;
      }
      if (method === 'HEAD' || method === 'PUT') {
        res.writeHead(200);
        res.end();
        return;
      }
    }

    // Multipart upload.
    if (method === 'POST' && q.has('uploads')) {
      const uploadId = randomUUID();
      this.uploads.set(uploadId, new Map());
      xml(200, `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    if (method === 'PUT' && q.has('uploadId') && q.has('partNumber')) {
      this.uploads.get(q.get('uploadId')!)?.set(Number(q.get('partNumber')), body);
      res.writeHead(200, { etag: `"part-${q.get('partNumber')}"` });
      res.end();
      return;
    }
    if (method === 'POST' && q.has('uploadId')) {
      const parts = this.uploads.get(q.get('uploadId')!) ?? new Map<number, Buffer>();
      const joined = Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
      this.objects.set(id, { body: joined, contentType: 'application/octet-stream', lastModified: new Date() });
      this.uploads.delete(q.get('uploadId')!);
      xml(200, `<CompleteMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>"e2e"</ETag></CompleteMultipartUploadResult>`);
      return;
    }
    if (method === 'DELETE' && q.has('uploadId')) {
      this.uploads.delete(q.get('uploadId')!);
      res.writeHead(204);
      res.end();
      return;
    }

    switch (method) {
      case 'PUT': {
        const ct = headers['content-type'];
        this.objects.set(id, { body, contentType: typeof ct === 'string' ? ct : 'application/octet-stream', lastModified: new Date() });
        res.writeHead(200, { etag: '"e2e"' });
        res.end();
        return;
      }
      case 'GET':
      case 'HEAD': {
        const o = this.objects.get(id);
        if (!o) {
          if (method === 'HEAD') { res.writeHead(404); res.end(); return; }
          notFound();
          return;
        }
        const h: Record<string, string> = {
          'content-type': q.get('response-content-type') ?? o.contentType,
          'content-length': String(o.body.length),
          'last-modified': o.lastModified.toUTCString(),
          etag: '"e2e"',
          'access-control-allow-origin': '*',
        };
        const disposition = q.get('response-content-disposition');
        if (disposition) h['content-disposition'] = disposition;
        res.writeHead(200, h);
        res.end(method === 'HEAD' ? undefined : o.body);
        return;
      }
      case 'DELETE':
        this.objects.delete(id);
        res.writeHead(204);
        res.end();
        return;
      default:
        xml(405, '<Error><Code>MethodNotAllowed</Code></Error>');
    }
  }
}
