import { describe, it, expect } from 'vitest';
import {
  REJECTED_EXPORT_FILE_NAME,
  isTenantUploadKey,
  rejectedExportKey,
  uploadKey,
} from '../../../src/agency/agency-ingest-keys.js';

const T = 'tenant-1';
const ID = '11111111-2222-3333-4444-555555555555';

describe('agency ingest S3 keys (ClickUp 14ygtkj8rvv)', () => {
  it('accepts exactly what the upload route mints', () => {
    expect(isTenantUploadKey(uploadKey(T, ID, 'roster.csv'), T)).toBe(true);
  });

  it('refuses a rejected-rows export — it is keyed by nothing but a job id', () => {
    expect(isTenantUploadKey(rejectedExportKey(T, ID), T)).toBe(false);
  });

  it('never mints an upload key the check would mistake for an export', () => {
    const key = uploadKey(T, ID, REJECTED_EXPORT_FILE_NAME);
    expect(key.endsWith(`/${REJECTED_EXPORT_FILE_NAME}`)).toBe(false);
    expect(key.endsWith(`/upload-${REJECTED_EXPORT_FILE_NAME}`)).toBe(true);
    expect(isTenantUploadKey(key, T)).toBe(true);
  });

  it('gives an empty sanitised name a usable basename', () => {
    const key = uploadKey(T, ID, '');
    expect(isTenantUploadKey(key, T)).toBe(true);
  });

  it('keeps the tenant check', () => {
    expect(isTenantUploadKey(uploadKey(T, ID, 'roster.csv'), 'tenant-2')).toBe(false);
  });

  it.each([
    [`agency-ingest/${T}/${ID}`],
    [`agency-ingest/${T}/${ID}/a/roster.csv`],
    [`agency-ingest/${T}//roster.csv`],
    [`agency-ingest/${T}/${ID}/`],
    [`other/${T}/${ID}/roster.csv`],
  ])('refuses the malformed key %s', (key) => {
    expect(isTenantUploadKey(key, T)).toBe(false);
  });
});
