/** The fake S3 through the real AWS SDK, configured exactly as the server is in an e2e run. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Simulator } from '../src/sim/index.js';

let sim: Simulator;
let s3: S3Client;

beforeAll(async () => {
  sim = new Simulator({ port: 0, projectId: 'demo-x', voicelink: { username: 'u', password: 'p' }, serverOrigin: 'http://127.0.0.1:1' });
  await sim.start();
  s3 = new S3Client({
    region: 'ap-south-1',
    endpoint: `${sim.origin}/s3`,
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
});
afterAll(async () => {
  s3.destroy();
  await sim.stop();
});

describe('fake S3', () => {
  it('puts, heads, gets, lists and deletes an object, path-style', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'e2e-bucket', Key: 'agency-ingest/t/1/roster.csv', Body: 'name,phone\nA,9876500101\n', ContentType: 'text/csv' }));
    expect(sim.s3.keys('e2e-bucket')).toEqual(['agency-ingest/t/1/roster.csv']);

    const head = await s3.send(new HeadObjectCommand({ Bucket: 'e2e-bucket', Key: 'agency-ingest/t/1/roster.csv' }));
    expect(head.ContentType).toBe('text/csv');
    const got = await s3.send(new GetObjectCommand({ Bucket: 'e2e-bucket', Key: 'agency-ingest/t/1/roster.csv' }));
    expect(await got.Body!.transformToString()).toContain('9876500101');

    const list = await s3.send(new ListObjectsV2Command({ Bucket: 'e2e-bucket', Prefix: 'agency-ingest/' }));
    expect(list.Contents?.map((c) => c.Key)).toEqual(['agency-ingest/t/1/roster.csv']);

    await s3.send(new DeleteObjectCommand({ Bucket: 'e2e-bucket', Key: 'agency-ingest/t/1/roster.csv' }));
    await expect(s3.send(new GetObjectCommand({ Bucket: 'e2e-bucket', Key: 'agency-ingest/t/1/roster.csv' }))).rejects.toThrow();
  });
});
