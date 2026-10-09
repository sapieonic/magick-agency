import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * ─── THE PUBLIC API HALF OF THE ATTEMPT SPINE ────────────────────────────────
 *
 * The proxies themselves are thin, so the interesting behaviour is at the
 * edges — what the proxy forwards, what it refuses to forward, and what the export
 * does when the internal handler stops answering.
 *
 * Two properties carry the privacy decisions and are asserted rather
 * than left to the code review:
 *
 *  * a bulk export writes an audit row naming the actor, the filters and the
 *    row count — that row is what stands in for the second permission the
 *    export deliberately does NOT have;
 *  * neither export can carry a contact's uploaded CSV columns, because neither
 *    list route serves them.
 */

const TENANT = 'tenant-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  findDisplayNames: vi.fn(),
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFileBuffer: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// No governance mock: the route registers no `requireCapability('agency')`.
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNames },
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import {
  ATTEMPT_CSV_COLUMNS,
  CONTACT_CSV_COLUMNS,
  SPINE_EXPORT_MAX_ROWS,
  SPINE_EXPORT_TIME_BUDGET_MS,
  attemptCsvHeader,
  attemptCsvRow,
  contactCsvHeader,
  contactCsvRow,
} from '../../../src/agency/agency-spine.js';

const PREFIX = '/proxy/agency';
const CAMPAIGN = 'campaign-1';
const ACTING_USER = 'user-1';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = TENANT;
    (request as { accountId?: string }).accountId = 'account-1';
    (request as { user?: { id: string } }).user = { id: ACTING_USER };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** The internal handler's campaign body, which the ownership probe reads for the name. */
const CAMPAIGN_BODY = {
  status: 200,
  body: { id: CAMPAIGN, name: 'Q3 Renewals', account_id: 'core-account', status: 'stopped' },
  headers: new Headers(),
};

function page(rows: unknown[], nextCursor: string | null = null) {
  return { status: 200, body: { rows, next_cursor: nextCursor, limit: 500 }, headers: new Headers() };
}

const ATTEMPT = {
  id: 'attempt-1', contact_id: 'contact-1', attempt_number: 2, phone_e164: '+919876500001',
  caller_id: '+919000000001', agent_user_id: 'ac1f9d2e-1111-4222-8333-444455556666',
  state: 'ended', outcome: 'connected',
  disposition_code: 'not_interested', notes: 'call back after 6pm', callback_at: null,
  dispositioned_by_user_id: 'ac1f9d2e-1111-4222-8333-444455556666', dispositioned_at: '2026-08-17T10:00:00.000Z',
  dispositioned_on_behalf: false, webrtc_call_id: 'call-9',
  dialed_at: '2026-08-17T09:59:00.000Z', answered_at: '2026-08-17T09:59:10.000Z',
  bridged_at: '2026-08-17T09:59:12.000Z', ended_at: '2026-08-17T09:59:59.000Z',
  talk_seconds: 47, wrapup_seconds: 20, created_at: '2026-08-17T09:58:00.000Z',
};

const CONTACT = {
  id: 'contact-2', phone_e164: '+919876500003', state: 'suppressed', attempt_count: 0,
  our_fault_attempts: 0, last_outcome: null, last_disposition: null,
  next_attempt_at: '2026-08-17T09:00:00.000Z', suppressed_reason: 'dnc', timezone: null,
  csv_line_number: 41, created_at: '2026-08-17T08:00:00.000Z',
  updated_at: '2026-08-17T08:30:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findDisplayNames.mockResolvedValue(
    new Map([['ac1f9d2e-1111-4222-8333-444455556666', 'Ravi Menon']]),
  );
});

describe('the agent is named, not just identified', () => {
  // The internal handler has no user table (D3), so it serves `agent_user_id` — a UUID in
  // production. This surface once rendered that raw, which is a column a
  // supervisor can neither read nor filter by. The agent floor already does exactly this
  // enrichment.
  const AGENT_ID = 'ac1f9d2e-1111-4222-8333-444455556666';
  const WITH_AGENT = ATTEMPT;
  /** An abandoned attempt: nobody was ever reserved, so there is no agent. */
  const NO_AGENT = { ...ATTEMPT, id: 'attempt-none', agent_user_id: null, outcome: 'abandoned' };

  it('adds agent_name to every row from one lookup', async () => {
    mocks.proxyToCore.mockResolvedValue(page([WITH_AGENT, { ...WITH_AGENT, id: 'a2' }]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts`,
    });

    expect(res.json().rows[0].agent_name).toBe('Ravi Menon');
    expect(res.json().rows[1].agent_name).toBe('Ravi Menon');
    // One query for the page, never one per row.
    expect(mocks.findDisplayNames).toHaveBeenCalledTimes(1);
    expect(mocks.findDisplayNames).toHaveBeenCalledWith([AGENT_ID, AGENT_ID], TENANT);
    await app.close();
  });

  it('keeps the id alongside the name', async () => {
    mocks.proxyToCore.mockResolvedValue(page([WITH_AGENT]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts` });
    // The id is the stable join key for a downstream script; the name is for a
    // human. Replacing one with the other loses a consumer either way.
    expect(res.json().rows[0].agent_user_id).toBe(AGENT_ID);
    await app.close();
  });

  it('emits agent_name: null — never an absent key — for an attempt with no agent', async () => {
    mocks.proxyToCore.mockResolvedValue(page([NO_AGENT]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts` });
    // An abandoned attempt legitimately has no agent. An ABSENT key is
    // indistinguishable from a client that forgot to read it; a null is an
    // answer. No lookup is issued for a page with no agents at all.
    expect(res.json().rows[0]).toHaveProperty('agent_name', null);
    expect(mocks.findDisplayNames).not.toHaveBeenCalled();
    await app.close();
  });

  it('degrades to null rather than failing the read when identity is unavailable', async () => {
    mocks.findDisplayNames.mockRejectedValue(new Error('users db down'));
    mocks.proxyToCore.mockResolvedValue(page([WITH_AGENT]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts` });
    // A name is an improvement on the id, not a precondition for the row.
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].agent_name).toBeNull();
    expect(res.json().rows[0].agent_user_id).toBe(AGENT_ID);
    await app.close();
  });

  it('leaves a non-2xx body untouched', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 404, body: { error: 'Not Found' }, headers: new Headers(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found' });
    await app.close();
  });

  it('names the agent in the CSV too, so the file matches the screen', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([WITH_AGENT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
    });
    const [header, row] = res.body.trim().split('\n');
    expect(header).toContain('agent_name');
    expect(row).toContain('Ravi Menon');
    expect(row).toContain(AGENT_ID);
    await app.close();
  });
});

describe('the JSON proxies', () => {
  it('forwards the attempt filters and the cursor, and nothing else', async () => {
    mocks.proxyToCore.mockResolvedValue(page([ATTEMPT]));
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts`
        + '?outcome=abandoned&state=ended&agent_user_id=ravi&phone=500001'
        + '&from=2026-08-01T00:00:00Z&cursor=abc&limit=25',
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.path).toBe(`/agency-campaigns/${CAMPAIGN}/attempts`);
    expect(call.query).toEqual({
      outcome: 'abandoned', state: 'ended', agent_user_id: 'ravi', phone: '500001',
      from: '2026-08-01T00:00:00Z', cursor: 'abc', limit: '25',
    });
    await app.close();
  });

  /**
   * An undocumented param is now REFUSED rather than dropped, and the internal handler is never
   * called. `account_id` is the case worth pinning: the public API does not accept
   * it, and dropping it silently meant a caller could send it, get a 200, and
   * reasonably believe it had been applied.
   *
   * The refusal is also strictly safer than the drop it replaces — the param
   * still cannot reach the internal handler, and now the caller is told.
   */
  it('refuses an undocumented param instead of dropping it, without calling the internal handler', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts?outcome=abandoned&account_id=someone-else`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'unknown_query_params',
      details: { unknown: ['account_id'] },
    });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('joins a repeated param with a comma — the internal handler accepts both spellings', async () => {
    mocks.proxyToCore.mockResolvedValue(page([]));
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts?outcome=abandoned&outcome=no_answer`,
    });
    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({ outcome: 'abandoned,no_answer' });
    await app.close();
  });

  it('drops a blank filter rather than forwarding an empty search box', async () => {
    mocks.proxyToCore.mockResolvedValue(page([]));
    const app = await buildApp();
    await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts?phone=&state=` });
    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({});
    await app.close();
  });

  it('forwards the roster filters', async () => {
    mocks.proxyToCore.mockResolvedValue(page([CONTACT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts`
        + '?state=suppressed&suppressed_reason=dnc&last_disposition=voicemail',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].suppressed_reason).toBe('dnc');
    expect(mocks.proxyToCore.mock.calls[0]![0].query).toEqual({
      state: 'suppressed',
      suppressed_reason: 'dnc',
      last_disposition: 'voicemail',
    });
    await app.close();
  });

  it('joins a repeated last_disposition — the chip group is multi-select', async () => {
    mocks.proxyToCore.mockResolvedValue(page([]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts`
        + '?last_disposition=voicemail&last_disposition=callback',
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].query)
      .toEqual({ last_disposition: 'voicemail,callback' });
    await app.close();
  });

  /**
   * The tester's guess — "API probably wants `disposition`" — is the
   * wrong rename. The contacts parser reads `last_disposition` only.
   * An alias here would 200 a query the handler then ignores, which is the
   * silent-unfiltered defect this allow-list exists to prevent.
   */
  it('refuses the guessed alias `disposition` on the contact roster', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts?disposition=voicemail`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'unknown_query_params',
      details: { unknown: ['disposition'] },
    });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses last_disposition on the attempt list — that key is a contact filter', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts?last_disposition=voicemail`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'unknown_query_params',
      details: { unknown: ['last_disposition'] },
    });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards the internal handler\'s 404 unchanged, so a cross-tenant id and a missing one look the same', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 404, body: { error: 'Not Found', code: 'campaign_not_found' }, headers: new Headers(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
    await app.close();
  });

  it('proxies the single-contact drill-down, the only route carrying `context`', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: { ...CONTACT, context: { 'Loan Ref': 'L-42' } }, headers: new Headers(),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts/contact-2`,
    });
    expect(res.json().context).toEqual({ 'Loan Ref': 'L-42' });
    expect(mocks.proxyToCore.mock.calls[0]![0].path)
      .toBe(`/agency-campaigns/${CAMPAIGN}/contacts/contact-2`);
    await app.close();
  });
});

describe('the CSV writers stay in step with their headers', () => {
  // A column added to the header list and not to the row writer (or vice
  // versa) shifts every cell after it by one — silently, since both files
  // still parse. On an export destined for a compliance reader that puts a
  // disposition under "outcome" and a timestamp under "talk_seconds", and
  // nothing about the file says so. Adding `agent_name` was exactly this shape
  // of change.
  const cells = (line: string): number => {
    let count = 1;
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) count += 1;
    }
    return count;
  };

  it('attempts: every rendered row has exactly as many cells as the header', () => {
    const header = attemptCsvHeader().trimEnd();
    expect(cells(header)).toBe(ATTEMPT_CSV_COLUMNS.length);
    for (const row of [ATTEMPT, { ...ATTEMPT, agent_user_id: null, notes: 'a,b\nc "q"' }]) {
      expect(cells(attemptCsvRow(row as never).trimEnd())).toBe(ATTEMPT_CSV_COLUMNS.length);
    }
  });

  it('contacts: same invariant', () => {
    expect(cells(contactCsvHeader().trimEnd())).toBe(CONTACT_CSV_COLUMNS.length);
    for (const row of [CONTACT, { ...CONTACT, last_outcome: null, suppressed_reason: null }]) {
      expect(cells(contactCsvRow(row as never).trimEnd())).toBe(CONTACT_CSV_COLUMNS.length);
    }
  });
});

describe('the CSV exports', () => {
  it('drains every page and renders the attempt columns', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)                       // ownership probe
      .mockResolvedValueOnce(page([ATTEMPT], 'cursor-2'))
      .mockResolvedValueOnce(page([{ ...ATTEMPT, id: 'attempt-2' }]));

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attempts-Q3-Renewals.csv');
    expect(res.headers['x-export-rows']).toBe('2');
    expect(res.headers['x-export-truncated']).toBeUndefined();

    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(ATTEMPT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('attempt-1');
    expect(lines[2]).toContain('attempt-2');
    await app.close();
  });

  it('an abandoned attempt exports with empty agent and recording cells, not omitted', async () => {
    const abandoned = {
      ...ATTEMPT, id: 'attempt-3', agent_user_id: null, webrtc_call_id: null,
      outcome: 'abandoned', disposition_code: null, notes: null, talk_seconds: null,
      bridged_at: null, answered_at: null,
    };
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([abandoned]));

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
    });
    const row = res.body.trim().split('\n')[1]!;
    expect(row).toContain('abandoned');
    // The whole point: the row is present. A `null` becomes an empty cell, not
    // a dropped row and not the string "null".
    expect(row).not.toContain('null');
    expect(res.headers['x-export-rows']).toBe('1');
    await app.close();
  });

  /**
   * The failure this whole export is built to make impossible: a file that is
   * short and says it is complete.
   *
   * A mid-drain page whose `next_cursor` is neither a string nor absent used to
   * be coerced to `null`, which the loop reads as end-of-stream — so the export
   * stopped at the bad page and served the prefix as a finished file, 200, no
   * truncation header, preamble claiming completeness. Refusing outright is the
   * only honest answer: a partial CSV that announces itself is fine (`row_limit`
   * and `deadline` both do), a partial CSV that does not is what gets handed to
   * a regulator.
   */
  it.each([
    ['a numeric cursor', 12345],
    ['an object cursor', { at: 'x' }],
    ['a boolean cursor', true],
  ])('refuses the whole export when the internal handler sends %s mid-drain', async (_label, badCursor) => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([ATTEMPT], 'cursor-2'))
      .mockResolvedValueOnce({
        status: 200,
        body: { rows: [{ ...ATTEMPT, id: 'attempt-2' }], next_cursor: badCursor, limit: 500 },
        headers: new Headers(),
      });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('spine_export_unreadable');
    // Nothing partial escapes: no CSV body, and no row count that a caller
    // could mistake for a successful short export.
    expect(res.headers['content-type']).not.toContain('text/csv');
    expect(res.headers['x-export-rows']).toBeUndefined();
    await app.close();
  });

  it('a genuinely absent cursor is still end-of-stream, not a refusal', async () => {
    // The other half of the same rule — `null` and omitted both mean "that was
    // the last page", and tightening the check must not turn either into a 502.
    for (const body of [
      { rows: [ATTEMPT], next_cursor: null, limit: 500 },
      { rows: [ATTEMPT], limit: 500 },
    ]) {
      mocks.proxyToCore.mockReset();
      mocks.proxyToCore
        .mockResolvedValueOnce(CAMPAIGN_BODY)
        .mockResolvedValueOnce({ status: 200, body, headers: new Headers() });

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-export-rows']).toBe('1');
      expect(res.headers['x-export-truncated']).toBeUndefined();
      await app.close();
    }
  });

  it('a suppressed contact exports with its reason', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([CONTACT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv?preamble=false`,
    });
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(CONTACT_CSV_COLUMNS.join(','));
    expect(lines[1]).toContain('suppressed');
    expect(lines[1]).toContain('dnc');
    await app.close();
  });

  it('never exports the contact\'s uploaded CSV columns', async () => {
    // Even if the internal handler were to start serving them on the list, the writer has no
    // column for them — the exclusion is structural, not a filter someone has
    // to remember to apply.
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([{ ...CONTACT, context: { 'Internal Score': '0.91' } }]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv?preamble=false`,
    });
    expect(res.body).not.toContain('Internal Score');
    expect(res.body).not.toContain('0.91');
    expect(CONTACT_CSV_COLUMNS as readonly string[]).not.toContain('context');
    await app.close();
  });

  it('neutralises a spreadsheet formula in agent-typed notes', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([{ ...ATTEMPT, notes: '=HYPERLINK("http://evil","click")' }]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
    });
    // Notes are the one free-text field an agent types, and this file is opened
    // outside the organisation.
    expect(res.body).toContain("'=HYPERLINK");
    await app.close();
  });

  it('writes the preamble by default and states what the file does NOT contain', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([CONTACT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv?state=suppressed`,
    });
    expect(res.body).toContain('# Magick Agency — campaign contact roster export'); // B17
    expect(res.body).toContain('# Campaign: Q3 Renewals');
    expect(res.body).toContain('# Filter — state: suppressed');
    expect(res.body).toContain('# Rows exported: 1');
    expect(res.body).toContain('# Truncated: no');
    // The two absences a reader could not otherwise detect.
    expect(res.body).toContain('Phone numbers are unmasked');
    expect(res.body).toContain('Not included: the contact\'s uploaded CSV columns');
    await app.close();
  });

  it('forwards last_disposition on CSV export and writes it into the preamble', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([CONTACT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv?last_disposition=voicemail`,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[1]![0].query)
      .toEqual(expect.objectContaining({ last_disposition: 'voicemail' }));
    expect(res.body).toContain('# Filter — last_disposition: voicemail');
    await app.close();
  });

  it('refuses the guessed alias `disposition` on CSV export too', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv?disposition=voicemail`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'unknown_query_params',
      details: { unknown: ['disposition'] },
    });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('says so when no filter was applied, rather than omitting the line', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv`,
    });
    // A missing line reads as "nothing was filtered out" whether or not it was.
    expect(res.body).toContain('Filter — none applied');
    await app.close();
  });

  it('writes an audit row naming the actor, the filters and the row count', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ATTEMPT]));
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?outcome=abandoned&preamble=false`,
    });

    // This row IS the answer to "does a bulk export need its own permission".
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agency_attempts.exported',
      resource_type: 'agency_campaign',
      resource_id: CAMPAIGN,
      campaign_id: CAMPAIGN,
      user_id: ACTING_USER,
      tenant_id: TENANT,
      details: expect.objectContaining({ rows: 1, filters: { outcome: 'abandoned' } }),
    }));
    await app.close();
  });

  it('audits the roster export under its own action', async () => {
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([CONTACT]));
    const app = await buildApp();
    await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv` });
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agency_contacts.exported',
    }));
    await app.close();
  });

  it('forwards the internal handler\'s refusal mid-drain and sends no file', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce(page([ATTEMPT], 'cursor-2'))
      .mockResolvedValueOnce({
        status: 503, body: { error: 'Service Unavailable' }, headers: new Headers(),
      });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv`,
    });
    // A short CSV under a 200 is the one outcome an export must never produce —
    // nothing about the file would say it is short.
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).not.toContain('text/csv');
    // And nothing is audited: nothing left the building.
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a page it cannot read rather than writing a header-only file', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockResolvedValueOnce({ status: 200, body: { unexpected: true }, headers: new Headers() });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/contacts.csv`,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('spine_export_unreadable');
    await app.close();
  });

  it('marks a row-limited export and tells the operator what to do about it', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...ATTEMPT, id: `a-${i}` }));
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      // A cursor that never ends: the drain must stop on the ceiling, not on
      // the data running out.
      .mockResolvedValue(page(rows, 'next'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv`,
    });

    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.headers['x-export-truncated-reason']).toBe('row_limit');
    expect(res.headers['x-export-row-limit']).toBe(String(SPINE_EXPORT_MAX_ROWS));
    expect(res.headers['x-export-rows']).toBe(String(SPINE_EXPORT_MAX_ROWS));
    // Q-D is 1M contacts, so this is the ordinary outcome of an unfiltered
    // export rather than a rare one — the file has to say what to do next.
    expect(res.body).toContain('narrow the filters');
    // The audit row records that it was truncated: "50,000 of 1,000,000" is a
    // different disclosure from "the whole campaign".
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ truncated: 'row_limit' }),
    }));
    await app.close();
  }, 30_000);

  /*
   * The `deadline` truncation: the drain checks the wall-clock budget after each complete
   * page. The clock is driven from inside the internal read, so the deadline is exercised
   * by the loop.
   */
  it('stops at the time budget BETWEEN pages, marked deadline', async () => {
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let call = 0;
    mocks.proxyToCore.mockImplementation(async () => {
      call += 1;
      if (call === 1) return CAMPAIGN_BODY;
      now += SPINE_EXPORT_TIME_BUDGET_MS / 2 + 1;
      return page([ATTEMPT], 'more');
    });
    try {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=false`,
      });

      expect(res.statusCode).toBe(200);
      // Two pages fit inside the budget; the third is never asked for.
      expect(call).toBe(3);
      expect(res.headers['x-export-truncated']).toBe('true');
      expect(res.headers['x-export-truncated-reason']).toBe('deadline');
      expect(res.headers['x-export-rows']).toBe('2');
      expect(res.headers['x-export-row-limit']).toBeUndefined();
      await app.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('still fails loudly on an error that is NOT our abort', async () => {
    mocks.proxyToCore
      .mockResolvedValueOnce(CAMPAIGN_BODY)
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const app = await buildApp();
    // A transport failure must not be laundered into a short file marked
    // "truncated" — that would hand over a partial export as a deliberate one.
    await expect(app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv`,
    })).resolves.toMatchObject({ statusCode: 500 });
    await app.close();
  });

  it('honours ?preamble=FALSE as well as lowercase', async () => {
    // The only place a caller reads this spelling from is the preamble's own
    // last line, so an exact-case compare kept the block for anyone who typed
    // it as they would a boolean.
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ATTEMPT]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?preamble=FALSE`,
    });
    expect(res.body.startsWith('#')).toBe(false);
    await app.close();
  });

  it('caps a filter value before it reaches the audit row', async () => {
    // Only the KEYS are whitelisted; `disposition_code` is deliberately
    // un-vocabularied in the internal handler, so the VALUE is caller-controlled. Unbounded, a
    // 200KB value landed unchanged in the audit store — repeatable, on the one
    // trail a compliance reader depends on.
    const huge = 'x'.repeat(200_000);
    mocks.proxyToCore.mockResolvedValueOnce(CAMPAIGN_BODY).mockResolvedValueOnce(page([ATTEMPT]));
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts.csv?disposition_code=${huge}`,
    });

    const details = mocks.auditLog.mock.calls[0]![0].details as { filters: Record<string, string> };
    expect(details.filters['disposition_code']!.length).toBeLessThan(300);
    // Marked rather than silently cut — a truncated value that looked whole
    // would misreport what the export actually covered.
    expect(details.filters['disposition_code']).toContain('[truncated]');
    await app.close();
  });
});
