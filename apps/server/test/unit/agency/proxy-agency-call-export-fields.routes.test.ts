import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Export with fields, the public half (`docs/call-log.md` §10, CL43–CL52):
 * `GET /proxy/agency/campaigns/:id/attempts.csv?fields=` and
 * `GET /proxy/agency/campaigns/:id/call-log/export-fields`, over a scripted internal handler.
 *
 * What is pinned: the refusals and their order (400 before any read, the ownership probe, the
 * 403 without the analytics setting, never a drop), `include` forwarded only when a field needs
 * it, the header and the cells, the ceiling that applied in the headers, the preamble and the
 * audit row, and that with no `fields` the file is the plain export byte for byte.
 */

const TENANT = 'tenant-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  findDisplayNames: vi.fn(),
  findSettings: vi.fn(),
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/storage/s3.js', () => ({ getFileStream: vi.fn(), getFileBuffer: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({ agencyIngestService: { run: vi.fn() } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNames },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findSettings },
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { ATTEMPT_CSV_COLUMNS, SPINE_EXPORT_MAX_ROWS } from '../../../src/agency/agency-spine.js';

const PREFIX = '/proxy/agency';
const CAMPAIGN = 'campaign-1';
const CAMPAIGN_ACCOUNT = 'handler-account';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = TENANT;
    (request as { accountId?: string }).accountId = 'account-1';
    (request as { user?: { id: string } }).user = { id: 'user-1' };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

const ok = <B,>(body: B) => ({ status: 200, body, headers: new Headers() });
const CAMPAIGN_BODY = ok({ id: CAMPAIGN, name: 'Q3 Renewals', account_id: CAMPAIGN_ACCOUNT, status: 'running' });
const page = (rows: unknown[], next: string | null = null) => ok({ rows, next_cursor: next, limit: 500 });

const ROW = {
  source: 'dialler', id: 'attempt-1', contact_id: 'contact-1', attempt_number: 1, phone_e164: '+919876500001',
  caller_id: '+919000000001', agent_user_id: null, state: 'ended', outcome: 'connected', disposition_code: 'will_pay',
  notes: null, callback_at: null, dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
  webrtc_call_id: 'leg-1', dialed_at: null, answered_at: null, bridged_at: null, ended_at: null, talk_seconds: 40,
  wrapup_seconds: null, created_at: '2026-11-27T10:00:00.000Z',
  export_extras: {
    analysis_status: 'completed',
    call_analysis: { common: { summary: '=HYPERLINK("x")', key_topics: ['emi', 'waiver'] }, custom: { promise_strength: 'strong' } },
    call_fields: null,
  },
};
const SOFT_ROW = {
  ...ROW, source: 'soft_phone', id: 'manual-1', webrtc_call_id: null,
  export_extras: { analysis_status: null, call_analysis: null, call_fields: { loan_no: 'LN-42' } },
};
const FIELD_LIST = ok({
  calls: 2,
  analysis: {
    analysed: 1,
    fields: [{ name: 'analysis_status', calls: 2 }, { name: 'ai_summary', calls: 1 }],
    dimensions: [{ name: 'dim_promise_strength', key: 'promise_strength', types: ['enum'], options: ['strong', 'weak'], description: 'How firm the promise was', calls: 1, sources: ['dialler'] }],
  },
  call_fields: [{ name: 'field_loan_no', key: 'loan_no', label: 'Loan number', type: 'text', calls: 1 }],
});

const csv = (fields: string, extra = '') => `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?fields=${encodeURIComponent(fields)}${extra}`;
const corePaths = () => mocks.proxyToCore.mock.calls.map((c) => c[0].path as string);
const pageCalls = () => mocks.proxyToCore.mock.calls.map((c) => c[0]).filter((c) => c.path.endsWith('/call-log'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findDisplayNames.mockResolvedValue(new Map());
  mocks.findSettings.mockResolvedValue({ analyze_calls: true, allow_recording: true });
});

describe('attempts.csv?fields: refusals, before anything is read', () => {
  it('400 export_fields_invalid names the bad items, and reads nothing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('ai_summary,transcript,dim_Bad') });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'export_fields_invalid', details: { invalid: ['transcript', 'dim_Bad'] } });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 echoes at most ten bad items, each cut short, and counts them all', async () => {
    const app = await buildApp();
    const bad = Array.from({ length: 60 }, (_, i) => `bad_${i}_${'x'.repeat(200)}`).join(',');
    const res = await app.inject({ method: 'GET', url: csv(bad) });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ code: 'export_fields_invalid', details: { invalid_count: 60, count: 60, max: 100 } });
    expect(body.details.invalid).toHaveLength(10);
    for (const item of body.details.invalid as string[]) expect(item.length).toBeLessThanOrEqual(65);
    expect(body.message).toContain(' and 50 more.');
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('400 for more than 100 fields', async () => {
    const app = await buildApp();
    const many = Array.from({ length: 101 }, (_, i) => `field_k${i}`).join(',');
    const res = await app.inject({ method: 'GET', url: csv(many) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'export_fields_invalid', details: { count: 101, max: 100 } });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('a caller cannot send `include` itself: it is not one of the export\'s params', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?include=analysis` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params', details: { unknown: ['include'] } });
    await app.close();
  });

  it('a campaign the caller does not own is the probe\'s 404, before the setting is read', async () => {
    mocks.proxyToCore.mockResolvedValueOnce({ status: 404, body: { code: 'campaign_not_found' }, headers: new Headers() });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('ai_summary') });
    expect(res.statusCode).toBe(404);
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('attempts.csv?fields: the analytics setting (CL47)', () => {
  it('403 export_fields_not_permitted for analysis or dimension fields without it, naming them; nothing drained', async () => {
    for (const settings of [{ analyze_calls: false }, null, { analyze_calls: null }]) {
      vi.clearAllMocks();
      mocks.findSettings.mockResolvedValue(settings);
      mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY);
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: csv('field_loan_no,analysis_status,dim_x') });
      expect(res.statusCode, JSON.stringify(settings)).toBe(403);
      expect(res.json()).toMatchObject({ code: 'export_fields_not_permitted', details: { fields: ['analysis_status', 'dim_x'] } });
      expect(res.json().message).toContain('Call analysis is turned off');
      expect(corePaths()).toEqual([`/agency-campaigns/${CAMPAIGN}`]);
      expect(mocks.auditLog).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('reads the CAMPAIGN\'s account\'s setting, and fails closed when the read throws', async () => {
    mocks.findSettings.mockRejectedValue(new Error('db down'));
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('ai_summary') });
    expect(res.statusCode).toBe(403);
    expect(mocks.findSettings).toHaveBeenCalledWith(TENANT, CAMPAIGN_ACCOUNT);
    await app.close();
  });

  it('call details alone need no setting, and the setting is not read', async () => {
    mocks.findSettings.mockResolvedValue({ analyze_calls: false });
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([SOFT_ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('field_loan_no', '&preamble=false') });
    expect(res.statusCode).toBe(200);
    expect(mocks.findSettings).not.toHaveBeenCalled();
    expect(res.body.trim().split('\n')[1]!.endsWith(',LN-42')).toBe(true);
    await app.close();
  });
});

describe('attempts.csv?fields: what is asked of the call log read', () => {
  it('include=call_fields only for call details; include=analysis only for analysis that reads the result; both for both', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['field_loan_no', 'call_fields'],
      // analysis_status alone: the status, never the stored result.
      ['analysis_status', 'analysis_status'],
      ['analysis_status,field_a', 'analysis_status,call_fields'],
      ['analysis_status,dim_x', 'analysis'],
      ['ai_key_topics,field_a', 'analysis,call_fields'],
    ];
    for (const [fields, include] of cases) {
      vi.clearAllMocks();
      mocks.findSettings.mockResolvedValue({ analyze_calls: true });
      mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW], 'c2')).mockResolvedValueOnce(page([ROW]));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: csv(fields, '&outcome=connected&preamble=false') });
      expect(res.statusCode, fields).toBe(200);
      // On every page, beside the filters, and `fields` itself never reaches the handler.
      expect(pageCalls()).toHaveLength(2);
      for (const call of pageCalls()) {
        expect(call.query.include, fields).toBe(include);
        expect(call.query.outcome).toBe('connected');
        expect(call.query).not.toHaveProperty('fields');
      }
      await app.close();
    }
  });

  it('a dimension reads its description from the field list, with the file\'s own filters, once', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(FIELD_LIST).mockResolvedValueOnce(page([ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('dim_promise_strength', '&source=dialler') });
    expect(res.statusCode).toBe(200);
    const listCall = mocks.proxyToCore.mock.calls[1]![0];
    expect(listCall.path).toBe(`/agency-campaigns/${CAMPAIGN}/call-log/export-fields`);
    expect(listCall.query).toEqual({ source: 'dialler', include_analysis: '1' });
    expect(res.body).toContain('# dim_promise_strength: How firm the promise was\n');
    await app.close();
  });

  it('no preamble, no field-list read: the descriptions are for the preamble alone', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('dim_promise_strength', '&source=dialler&preamble=false') });
    expect(res.statusCode).toBe(200);
    expect(corePaths()).toEqual([`/agency-campaigns/${CAMPAIGN}`, `/agency-campaigns/${CAMPAIGN}/call-log`]);
    expect(res.body.trimEnd().split('\n')[1]!.endsWith(',strong')).toBe(true);
    await app.close();
  });

  it('no dimension, no field-list read', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW]));
    const app = await buildApp();
    await app.inject({ method: 'GET', url: csv('ai_summary') });
    expect(corePaths()).toEqual([`/agency-campaigns/${CAMPAIGN}`, `/agency-campaigns/${CAMPAIGN}/call-log`]);
    await app.close();
  });

  it('the field list refusing stops the export: its status, no file, no audit row', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce({ status: 400, body: { error: 'Validation failed' }, headers: new Headers() });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('dim_x') });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).not.toContain('text/csv');
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('attempts.csv?fields: the file', () => {
  it('today\'s columns, then the chosen ones in the order asked, with their cells', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW, SOFT_ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('dim_promise_strength,ai_key_topics,field_loan_no,analysis_status', '&preamble=false') });
    const [header, dial, soft] = res.body.trimEnd().split('\n');
    expect(header).toBe([...ATTEMPT_CSV_COLUMNS, 'dim_promise_strength', 'ai_key_topics', 'field_loan_no', 'analysis_status'].join(','));
    expect(dial!.endsWith(',strong,emi; waiver,,completed')).toBe(true);
    expect(soft!.endsWith(',,,LN-42,none')).toBe(true);
    await app.close();
  });

  it('an AI summary that is a formula is guarded in the file', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('ai_summary', '&preamble=false') });
    expect(res.body.trimEnd().split('\n')[1]!.endsWith(',"\'=HYPERLINK(""x"")"')).toBe(true);
    await app.close();
  });

  it('X-Export-Row-Limit and the Truncated line report 20,000 with an AI field', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ ...ROW, id: `a-${i}` }));
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValue(page(rows, 'next'));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('ai_summary') });
    expect(res.headers['x-export-truncated-reason']).toBe('row_limit');
    expect(res.headers['x-export-row-limit']).toBe('20000');
    expect(res.headers['x-export-rows']).toBe('20000');
    expect(res.body).toContain('# Truncated: yes — stopped at the 20,000-row export ceiling.');
    expect(res.body).toContain('Row ceiling: 20,000 rows, because an AI field was chosen');
    expect(mocks.auditLog.mock.calls[0]![0].details).toMatchObject({ rows: 20000, truncated: 'row_limit', row_limit: 20000 });
    await app.close();
  }, 30_000);

  it('X-Export-Row-Limit stays 50,000 with call details and analysis_status only', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ ...SOFT_ROW, id: `m-${i}` }));
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValue(page(rows, 'next'));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('analysis_status,field_loan_no') });
    expect(res.headers['x-export-row-limit']).toBe(String(SPINE_EXPORT_MAX_ROWS));
    expect(res.headers['x-export-rows']).toBe(String(SPINE_EXPORT_MAX_ROWS));
    expect(res.body).toContain('# Truncated: yes — stopped at the 50,000-row export ceiling.');
    await app.close();
  }, 30_000);

  it('the preamble names the fields, the ceiling and the customer content, and the soft-phone note follows the choice', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([SOFT_ROW]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: csv('field_loan_no') });
    expect(res.body).toContain('# Fields added after callback_of, in this order: field_loan_no\n');
    expect(res.body).toContain('# Row ceiling: 50,000 rows.\n');
    expect(res.body).toContain('customer content');
    expect(res.body).toContain('any call detail not chosen as a field_ column');
    expect(res.body).not.toContain('Not included for a soft_phone row: the call details the agent entered');
    // The fields' lines sit inside the preamble: before the RFC 4180 note that ends it.
    expect(res.body.indexOf('Fields added')).toBeLessThan(res.body.indexOf('This preamble is not an RFC 4180 data row'));
    await app.close();
  });

  it('the audit row records the field names, never their values, and the ceiling', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([SOFT_ROW]));
    const app = await buildApp();
    await app.inject({ method: 'GET', url: csv('field_loan_no,analysis_status', '&outcome=connected') });
    const details = mocks.auditLog.mock.calls[0]![0].details;
    expect(details).toEqual({
      campaign_id: CAMPAIGN, rows: 1, filters: { outcome: 'connected' },
      fields: ['field_loan_no', 'analysis_status'], row_limit: SPINE_EXPORT_MAX_ROWS,
    });
    expect(JSON.stringify(details)).not.toContain('LN-42');
    await app.close();
  });
});

describe('attempts.csv without fields: the plain export, unchanged (CL43)', () => {
  /**
   * The plain file as it was before Export with fields, byte for byte apart from the Generated
   * line: pinned literally, so any change to the plain path shows up here.
   */
  const PLAIN = [
    '# Magick Agency — campaign call export (one row per dial, one per soft-phone call logged to the campaign, and one per inbound call filed under it)',
    '# Generated: <time> (UTC)',
    '# Campaign: Q3 Renewals (id: campaign-1)',
    '# Tenant: tenant-1',
    '# Account: handler-account',
    '# Filter — outcome: connected',
    '# Rows exported: 1',
    '# Truncated: no — this is every row matching the filters above',
    '# Phone numbers are unmasked. This file is the personal data of everyone listed in it — handle and retain it accordingly.',
    '# Not included: the contact\'s uploaded CSV columns. Those are shown one contact at a time in the console and are deliberately not exported in bulk.',
    '# Rows with no agent and no recording are real: an attempt that was abandoned, failed or never answered has neither. They are the rows a call list cannot show.',
    '# The source column says where each row came from: dialler (the campaign\'s own dial) or soft_phone (a call an agent placed on the soft phone and logged to this campaign; its attempt_number, wrapup_seconds and auto_disposition_code are empty). Soft-phone calls logged to no campaign are not in this file. Pass ?source=dialler for the dialler\'s rows alone. The promise_date and promise_amount columns after it are the promise to pay recorded with the row\'s outcome, empty where there is none.',
    '# An inbound row is a call a customer made to us that is filed under this campaign and has ended: phone is the caller\'s number (empty when withheld), caller_id the number they rang, agent_user_id who answered (empty for a missed call), created_at when it arrived. wait_seconds is how long the caller was with us before an agent answered, or before the call ended; missed_reason says why a call reached nobody. callback_of, on a soft_phone row, is the attempt_id of the missed inbound call it rang back. A call still in progress, one we turned away, and one filed under no campaign are not in this file.',
    '# Not included for a soft_phone row: the call details the agent entered and the reasons given for dialling through a Do Not Call entry or outside calling hours. Each is on the call\'s own page in the console (Call log, Soft-phone calls).',
    '# This preamble is not an RFC 4180 data row and some strict CSV parsers will reject it; pass ?preamble=false on this export to omit it.',
    'attempt_id,contact_id,attempt_number,phone,caller_id,agent_user_id,agent_name,state,outcome,disposition_code,dispositioned_by_user_id,dispositioned_on_behalf,notes,callback_at,created_at,dialed_at,answered_at,bridged_at,ended_at,talk_seconds,wrapup_seconds,recording_call_id,auto_disposition_code,source,promise_date,promise_amount,wait_seconds,missed_reason,callback_of',
    "attempt-1,contact-1,1,'+919876500001,'+919000000001,,,ended,connected,will_pay,,false,,,2026-11-27T10:00:00.000Z,,,,,40,,leg-1,,dialler,,,,,",
    '',
  ].join('\n');

  for (const fieldsParam of ['', '&fields=', '&fields=%20,%20']) {
    it(`is the plain file, headers and audit row included${fieldsParam ? ` (${decodeURIComponent(fieldsParam)})` : ''}`, async () => {
      // A row carrying extras it was never asked for still writes the plain cells only.
      mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ROW]));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?outcome=connected${fieldsParam}` });
      expect(res.statusCode).toBe(200);
      expect(res.body.replace(/^# Generated: .* \(UTC\)$/m, '# Generated: <time> (UTC)')).toBe(PLAIN);
      expect(pageCalls()[0]!.query).toEqual({ outcome: 'connected', limit: '500' });
      expect(mocks.findSettings).not.toHaveBeenCalled();
      expect(corePaths()).toEqual([`/agency-campaigns/${CAMPAIGN}`, `/agency-campaigns/${CAMPAIGN}/call-log`]);
      expect(mocks.auditLog.mock.calls[0]![0].details).toEqual({ campaign_id: CAMPAIGN, rows: 1, filters: { outcome: 'connected' } });
      expect(res.headers['x-export-rows']).toBe('1');
      expect(res.headers['x-export-row-limit']).toBeUndefined();
      await app.close();
    });
  }
});

describe('GET /campaigns/:id/call-log/export-fields', () => {
  const url = (q = '') => `${PREFIX}/campaigns/${CAMPAIGN}/call-log/export-fields${q}`;

  it('with the setting: asks for the analysis groups and answers the contract\'s shape', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(FIELD_LIST);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: url('?type=soft_phone&status=settled&outcome=connected') });
    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[1]![0];
    expect(call.path).toBe(`/agency-campaigns/${CAMPAIGN}/call-log/export-fields`);
    expect(call.query).toEqual({ source: 'soft_phone', status: 'settled', outcome: 'connected', include_analysis: '1' });
    expect(mocks.findSettings).toHaveBeenCalledWith(TENANT, CAMPAIGN_ACCOUNT);
    expect(res.json()).toEqual({
      calls: 2,
      analysis_available: true,
      analysed: 1,
      analysis: [{ name: 'analysis_status', calls: 2 }, { name: 'ai_summary', calls: 1 }],
      dimensions: FIELD_LIST.body.analysis.dimensions,
      call_fields: FIELD_LIST.body.call_fields,
      row_limit: 50_000,
      ai_row_limit: 20_000,
    });
    await app.close();
  });

  it('without the setting (off, no row, a failed read): never asks for the analysis, and says so', async () => {
    for (const settings of [Promise.resolve({ analyze_calls: false }), Promise.resolve(null), Promise.reject(new Error('down'))]) {
      vi.clearAllMocks();
      mocks.findSettings.mockReturnValue(settings);
      settings.catch(() => {});
      mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(ok({ calls: 2, analysis: null, call_fields: FIELD_LIST.body.call_fields }));
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: url('?type=all') });
      expect(res.statusCode).toBe(200);
      expect(mocks.proxyToCore.mock.calls[1]![0].query).toEqual({});
      expect(res.json()).toMatchObject({ analysis_available: false, analysed: null, analysis: [], dimensions: [], call_fields: FIELD_LIST.body.call_fields });
      await app.close();
    }
  });

  it('refuses what the Call log refuses, and what only the list takes', async () => {
    const app = await buildApp();
    for (const q of ['?type=bogus', '?include_counts=1', '?cursor=x', '?limit=5', '?include_analysis=1', '?fields=ai_summary', '?source=dialler']) {
      const res = await app.inject({ method: 'GET', url: url(q) });
      expect(res.statusCode, q).toBe(400);
    }
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards a refusal unchanged, and refuses a body it cannot read', async () => {
    mocks.proxyToCore.mockResolvedValueOnce({ status: 404, body: { code: 'campaign_not_found' }, headers: new Headers() });
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: url() })).statusCode).toBe(404);
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(ok({ rows: [] }));
    const bad = await app.inject({ method: 'GET', url: url() });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().code).toBe('call_export_fields_unreadable');
    await app.close();
  });
});

describe('the JSON Call log cannot reach the extras', () => {
  it('refuses `include` rather than forwarding it', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/call-log?include=analysis` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unknown_query_params', details: { unknown: ['include'] } });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});
