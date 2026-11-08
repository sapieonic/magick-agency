import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

describe('parseConfig', () => {
  it('parses a minimal environment with agency defaults', () => {
    const result = parseConfig(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.server.port).toBe(3021);
    expect(result.config.db.url).toBe(valid.DATABASE_URL);
  });

  it('agency.insightsRollup: 15 s and 200 buckets by default, read from the env, bounded', () => {
    const rollup = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? result.config.agency.insightsRollup : null;
    };
    expect(rollup({})).toEqual({ intervalMs: 15_000, batchSize: 200 });
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS: '30000', AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: '50' }))
      .toEqual({ intervalMs: 30_000, batchSize: 50 });
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_INTERVAL_MS: '10' })).toBeNull();
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: '0' })).toBeNull();
    expect(rollup({ AGENCY_INSIGHTS_ROLLUP_BATCH_SIZE: 'many' })).toBeNull();
  });

  it('agency.customerHistory: 30 a minute, 30 minutes, 10,000 rows by default, read from the env, bounded', () => {
    const history = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? result.config.agency.customerHistory : null;
    };
    expect(history({})).toEqual({ searchesPerMinute: 30, searchTtlMinutes: 30, exportMaxRows: 10_000 });
    expect(history({
      AGENCY_CUSTOMER_SEARCH_PER_MINUTE: '5',
      AGENCY_CUSTOMER_SEARCH_TTL_MINUTES: '10',
      AGENCY_CUSTOMER_EXPORT_MAX_ROWS: '500',
    })).toEqual({ searchesPerMinute: 5, searchTtlMinutes: 10, exportMaxRows: 500 });
    expect(history({ AGENCY_CUSTOMER_SEARCH_PER_MINUTE: '0' })).toBeNull();
    expect(history({ AGENCY_CUSTOMER_SEARCH_TTL_MINUTES: '100000' })).toBeNull();
    expect(history({ AGENCY_CUSTOMER_EXPORT_MAX_ROWS: 'all' })).toBeNull();
  });

  describe('agency.reports (docs/reports.md "Config")', () => {
    const reports = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? result.config.agency.reports : null;
    };
    const messages = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? [] : result.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    const SQS = {
      AGENCY_REPORTS_RENDERER: 'sqs',
      AGENCY_REPORTS_SQS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/report-jobs',
      AGENCY_REPORTS_CALLBACK_BASE_URL: 'https://api.example.com/',
      AGENCY_REPORTS_CALLBACK_SECRET: 'x'.repeat(32),
      S3_AUDIO_BUCKET: 'magick-agency-dev-media',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    };

    it('defaults: inline, 100,000 rows, 2 s, 60 s, 15 min, 3 attempts, 90 days, 5 pending, 3 a minute', () => {
      expect(reports({})).toEqual({
        renderer: 'inline',
        sqsQueueUrl: undefined,
        callbackBaseUrl: undefined,
        callbackSecret: undefined,
        chromePath: undefined,
        maxDetailRows: 100_000,
        assemblerIntervalMs: 2_000,
        tickIntervalMs: 60_000,
        renderTimeoutMs: 900_000,
        maxAttempts: 3,
        retentionDays: 90,
        tenantPendingLimit: 5,
        userPerMinute: 3,
      });
    });

    it('reads every key from the env, numbers coerced, an empty renderer is the default', () => {
      expect(reports({
        AGENCY_REPORTS_RENDERER: '',
        AGENCY_REPORTS_CHROME_PATH: '/usr/bin/chromium',
        AGENCY_REPORTS_MAX_DETAIL_ROWS: '5000',
        AGENCY_REPORTS_ASSEMBLER_INTERVAL_MS: '500',
        AGENCY_REPORTS_TICK_INTERVAL_MS: '30000',
        AGENCY_REPORTS_RENDER_TIMEOUT_MS: '60000',
        AGENCY_REPORTS_MAX_ATTEMPTS: '5',
        AGENCY_REPORTS_RETENTION_DAYS: '30',
        AGENCY_REPORTS_TENANT_PENDING_LIMIT: '10',
        AGENCY_REPORTS_USER_PER_MINUTE: '6',
      })).toMatchObject({
        renderer: 'inline', chromePath: '/usr/bin/chromium', maxDetailRows: 5000, assemblerIntervalMs: 500,
        tickIntervalMs: 30_000, renderTimeoutMs: 60_000, maxAttempts: 5, retentionDays: 30,
        tenantPendingLimit: 10, userPerMinute: 6,
      });
    });

    it('bounds the numbers and the renderer', () => {
      const bad: Array<Record<string, string>> = [
        { AGENCY_REPORTS_RENDERER: 'lambda' },
        { AGENCY_REPORTS_MAX_DETAIL_ROWS: '0' },
        { AGENCY_REPORTS_MAX_ATTEMPTS: '0' },
        { AGENCY_REPORTS_RETENTION_DAYS: 'forever' },
        { AGENCY_REPORTS_TENANT_PENDING_LIMIT: '0' },
        { AGENCY_REPORTS_USER_PER_MINUTE: '1.5' },
        { AGENCY_REPORTS_ASSEMBLER_INTERVAL_MS: '10' },
      ];
      for (const env of bad) {
        expect(reports(env), JSON.stringify(env)).toBeNull();
      }
    });

    it('sqs with its queue, callback base and a 32-character secret boots; the base loses its trailing slash', () => {
      expect(reports(SQS)).toMatchObject({
        renderer: 'sqs',
        sqsQueueUrl: SQS.AGENCY_REPORTS_SQS_QUEUE_URL,
        callbackBaseUrl: 'https://api.example.com',
        callbackSecret: 'x'.repeat(32),
      });
    });

    it('sqs without its settings fails boot, naming each missing one', () => {
      expect(messages({ AGENCY_REPORTS_RENDERER: 'sqs' })).toEqual([
        'agency.reports.sqsQueueUrl: AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_SQS_QUEUE_URL (the https:// queue URL)',
        "agency.reports.callbackBaseUrl: AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_CALLBACK_BASE_URL (the server's public base URL, http(s)://host, no path)",
        'agency.reports.callbackSecret: AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_CALLBACK_SECRET of at least 32 characters',
      ]);
      expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_SECRET: 'x'.repeat(31) })).toEqual([
        'agency.reports.callbackSecret: AGENCY_REPORTS_RENDERER=sqs needs AGENCY_REPORTS_CALLBACK_SECRET of at least 32 characters',
      ]);
      expect(messages({ ...SQS, AGENCY_REPORTS_SQS_QUEUE_URL: 'report-jobs' })).toHaveLength(1);
      expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_BASE_URL: 'api.example.com' })).toHaveLength(1);
      // A path would put the webhook under it (`/api/webhooks/…`), a route that 404s.
      expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_BASE_URL: 'https://api.example.com/api' })).toHaveLength(1);
      expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_BASE_URL: 'https://api.example.com' })).toHaveLength(0);
      expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_SECRET: ' '.repeat(40) })).toHaveLength(1);
    });

    it('sqs without the S3 bucket fails boot, naming S3_AUDIO_BUCKET (runs would queue and never finish)', () => {
      const { S3_AUDIO_BUCKET: _bucket, AWS_ACCESS_KEY_ID: _id, AWS_SECRET_ACCESS_KEY: _secret, ...noS3 } = SQS;
      expect(messages(noS3)).toEqual([
        'agency.reports.renderer: AGENCY_REPORTS_RENDERER=sqs needs the S3 bucket the renderer reads and writes: '
          + 'set S3_AUDIO_BUCKET (with AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)',
      ]);
      // Inline without a bucket still boots (it warns; a dev box may not have one).
      expect(reports({ AGENCY_REPORTS_RENDERER: 'inline' })).not.toBeNull();
    });

    it('the callback secret is used exactly as written: never trimmed, leading or trailing whitespace refused', () => {
      const secret = `${'x'.repeat(20)} ${'y'.repeat(20)}`; // inner whitespace is part of the value
      expect(reports({ ...SQS, AGENCY_REPORTS_CALLBACK_SECRET: secret })?.callbackSecret).toBe(secret);
      const refused = 'agency.reports.callbackSecret: AGENCY_REPORTS_CALLBACK_SECRET has leading or trailing whitespace: '
        + 'remove it here and in the renderer\'s copy (the callback is signed with the value exactly as written)';
      for (const padded of [` ${'x'.repeat(32)}`, `${'x'.repeat(32)}\n`, `${'x'.repeat(32)} `]) {
        expect(messages({ ...SQS, AGENCY_REPORTS_CALLBACK_SECRET: padded }), JSON.stringify(padded)).toEqual([refused]);
      }
      // Inline uses a configured secret too (the webhook verifies with it), so the rule holds there.
      expect(messages({ AGENCY_REPORTS_CALLBACK_SECRET: ' padded ' })).toEqual([refused]);
    });

    it('inline needs none of the sqs settings', () => {
      expect(reports({ AGENCY_REPORTS_RENDERER: 'inline', AGENCY_REPORTS_CALLBACK_SECRET: 'short' })).toMatchObject({
        renderer: 'inline', callbackSecret: 'short',
      });
    });
  });

  it('reports every missing required value', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['db.url', 'redis.url']));
  });

  it('rejects an invalid NODE_ENV', () => {
    const result = parseConfig({ ...valid, NODE_ENV: 'staging' });
    expect(result.ok).toBe(false);
  });

  it('READYZ_DETAIL_TOKEN: unset or blank is off; set must be at least 32 characters', () => {
    const token = (env: Record<string, string>) => {
      const result = parseConfig({ ...valid, ...env });
      return result.ok ? { ok: true, token: result.config.server.readyzDetailToken } : { ok: false };
    };
    expect(token({})).toEqual({ ok: true, token: undefined });
    expect(token({ READYZ_DETAIL_TOKEN: '  ' })).toEqual({ ok: true, token: undefined });
    expect(token({ READYZ_DETAIL_TOKEN: 'short' })).toEqual({ ok: false });
    expect(token({ READYZ_DETAIL_TOKEN: 'x'.repeat(32) })).toEqual({ ok: true, token: 'x'.repeat(32) });
  });
});

describe('CORS_ALLOWED_ORIGINS', () => {
  const origins = (value: string | undefined) => {
    const result = parseConfig({ ...valid, ...(value === undefined ? {} : { CORS_ALLOWED_ORIGINS: value }) });
    return result.ok ? { ok: true, origins: result.config.server.corsAllowedOrigins } : { ok: false };
  };

  it('unset, blank or only commas is an empty list (no CORS)', () => {
    expect(origins(undefined)).toEqual({ ok: true, origins: [] });
    expect(origins('')).toEqual({ ok: true, origins: [] });
    expect(origins(' , ,')).toEqual({ ok: true, origins: [] });
  });

  it('splits on commas and trims each entry', () => {
    expect(origins(' https://app.example.com , https://staging.app.example.com,http://localhost:5175 ')).toEqual({
      ok: true,
      origins: ['https://app.example.com', 'https://staging.app.example.com', 'http://localhost:5175'],
    });
  });

  it('normalises each entry to the form a browser sends as Origin', () => {
    expect(origins('https://App.Example.com,https://app.example.com:443,http://localhost:80,https://app.example.com:8443')).toEqual({
      ok: true,
      origins: ['https://app.example.com', 'https://app.example.com', 'http://localhost', 'https://app.example.com:8443'],
    });
  });

  it('refuses anything that is not a bare http(s) origin', () => {
    for (const bad of ['*', 'https://app.example.com/', 'https://app.example.com/console', 'app.example.com', 'wss://app.example.com', 'https://app.example.com?x=1', 'https://app.example.com?', 'https://app.example.com#x', 'https://u:p@app.example.com', 'https://', 'not a url']) {
      expect(origins(bad), bad).toEqual({ ok: false });
    }
  });
});
