import { afterEach, describe, expect, it } from 'vitest';
import { buildSslOption, closePool, initDbPool } from '../../../src/connection.js';

/**
 * Decision Q1: Postgres TLS verifies the server certificate by default. A
 * `{ rejectUnauthorized: false }` option would encrypt but accept any certificate.
 * Mutation-checked: restoring that literal in `buildSslOption` reds the default and CA cases.
 */
describe('buildSslOption (Q1)', () => {
  it('no TLS when ssl is off, whatever else is set', () => {
    expect(buildSslOption({})).toBeUndefined();
    expect(buildSslOption({ ssl: false, sslCa: 'PEM', sslRejectUnauthorized: false })).toBeUndefined();
  });

  it('ssl on verifies the certificate by default', () => {
    expect(buildSslOption({ ssl: true })).toEqual({ rejectUnauthorized: true });
  });

  it('a CA is passed through, still verifying', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    expect(buildSslOption({ ssl: true, sslCa: ca })).toEqual({ rejectUnauthorized: true, ca });
  });

  it('only an explicit false turns verification off', () => {
    expect(buildSslOption({ ssl: true, sslRejectUnauthorized: false })).toEqual({ rejectUnauthorized: false });
    expect(buildSslOption({ ssl: true, sslRejectUnauthorized: true })).toEqual({ rejectUnauthorized: true });
  });
});

describe('initDbPool hands the mapped option to pg', () => {
  afterEach(async () => { await closePool(); });

  it('the pool is configured with the verified ssl object (no connection is opened)', () => {
    // Port 5436 (agency's); a pool connects lazily, so nothing is dialled here.
    const pool = initDbPool({ url: 'postgresql://u:p@localhost:5436/none', poolMin: 0, ssl: true });
    expect((pool as unknown as { options: { ssl: unknown } }).options.ssl).toEqual({ rejectUnauthorized: true });
  });
});
