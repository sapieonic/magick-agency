import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * The report routes (`proxy-agency-reports.routes.ts`, docs/reports.md), with the REAL
 * `requirePermission` over the real matrix and every dependency faked through the plugin's
 * `deps` option: the flag gate on every route, who may run what (agent self vs another agent,
 * supervisor, campaign probe, the context account), the body and the window/zone rules, the
 * per-user rate and the tenant's pending limit, history scoping, the download rules and
 * presign, retry and run-now as NEW ad hoc runs, and the subscription CRUD with its schedule,
 * recipient and `next_run_at` rules. The SQL behind the fakes is pinned on Postgres by the
 * repositories' integration tests and the reports round trip.
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { proxyAgencyReportsRoutes } from '../../../../src/api/routes/proxy-agency-reports.routes.js';
import type { ReportRouteDeps } from '../../../../src/api/routes/proxy-agency-reports/shared.js';
import { agencyConfigSchema } from '../../../../src/config/blocks/agency.js';
import type {
  ReportRunCreateInput,
  ReportRunCreateLimits,
  ReportRunRecord,
  ReportSubscriptionCreateInput,
  ReportSubscriptionPatch,
  ReportSubscriptionRecord,
} from '../../../../src/db/repositories/agency.repository.js';
import {
  ACCOUNT, AGENT, CAMPAIGN, OTHER_ACCOUNT, RUN, SUBSCRIPTION, SUPERVISOR, TENANT, runRecord, subscriptionRecord,
} from '../../agency/reports/run-fixture.js';

const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';
const FOREIGN_CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-11-08T10:00:00Z');
const ZONE_NOT_IN_POSTGRES = 'America/Ciudad_Juarez';
const config = agencyConfigSchema.parse({}).agency.reports;
/** The limits every ad hoc create hands the repository. */
const LIMITS = expect.objectContaining({ pendingLimit: config.tenantPendingLimit, requesterRate: expect.objectContaining({ limit: config.userPerMinute }) });

/** `tenantId` / `accountId`: the headers as the client sent them (the tenant middleware keeps their case). */
interface Caller { userId: string; role: MembershipRole; accountId?: string; tenantId?: string }
const supervisor: Caller = { userId: SUPERVISOR, role: 'account_admin' };
const agent: Caller = { userId: AGENT, role: 'agent' };
const otherAgent: Caller = { userId: OTHER_AGENT, role: 'agent' };

function fakeDeps() {
  const runs = new Map<string, ReportRunRecord>();
  const subs = new Map<string, ReportSubscriptionRecord>();
  let seq = 0;
  const audits: Array<{ action: string; resource_id?: string; details?: Record<string, unknown> }> = [];
  const deps = {
    config,
    flag: true,
    recent: 0,
    queueFull: false,
    runs: {
      // The repository counts both limits inside its insert transaction: `recent` stands in for
      // the requester's runs in the window, `queueFull` for the tenant's pending count.
      create: vi.fn(async (input: ReportRunCreateInput, limits: ReportRunCreateLimits) => {
        if (limits.requesterRate && deps.recent >= limits.requesterRate.limit) {
          return { ok: false as const, reason: 'rate_limited' as const, recent: deps.recent };
        }
        if (deps.queueFull) return { ok: false as const, reason: 'queue_full' as const, pending: 5 };
        seq += 1;
        const id = `${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
        const run = runRecord({
          id, tenant_id: input.tenantId, account_id: input.accountId, kind: input.kind, subject_id: input.subjectId,
          campaign_ids: input.campaignIds ?? null, local_from: input.localFrom, local_to: input.localTo,
          timezone: input.timezone, range_from: input.rangeFrom, range_to: input.rangeTo, formats: input.formats,
          audience: input.audience, requested_by: input.requestedBy, email_me: input.emailMe ?? false, created_at: NOW,
        });
        runs.set(id, run);
        return { ok: true as const, run };
      }),
      findById: vi.fn(async (tenantId: string, id: string) => {
        const run = runs.get(id);
        return run && run.tenant_id === tenantId ? run : null;
      }),
      list: vi.fn(async (_params: unknown) => ({ rows: [...runs.values()], next_cursor: null, limit: 25 })),
    },
    subscriptions: {
      create: vi.fn(async (input: ReportSubscriptionCreateInput) => {
        const sub = subscriptionRecord({
          id: SUBSCRIPTION, kind: input.kind, subject_id: input.subjectId, cadence: input.cadence,
          send_local_time: input.sendLocalTime, send_weekday: input.sendWeekday, send_monthday: input.sendMonthday,
          timezone: input.timezone, formats: input.formats, recipient_user_ids: input.recipientUserIds,
          enabled: input.enabled, next_run_at: input.nextRunAt, created_by: input.createdBy, account_id: input.accountId,
        });
        subs.set(sub.id, sub);
        return sub;
      }),
      update: vi.fn(async (_tenantId: string, id: string, patch: ReportSubscriptionPatch) => {
        const sub = subs.get(id);
        if (!sub) return null;
        const next = {
          ...sub,
          ...(patch.cadence ? { cadence: patch.cadence } : {}),
          ...(patch.sendLocalTime ? { send_local_time: patch.sendLocalTime } : {}),
          ...(patch.timezone ? { timezone: patch.timezone } : {}),
          ...(patch.sendWeekday !== undefined ? { send_weekday: patch.sendWeekday } : {}),
          ...(patch.sendMonthday !== undefined ? { send_monthday: patch.sendMonthday } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.nextRunAt !== undefined ? { next_run_at: patch.nextRunAt } : {}),
          ...(patch.formats ? { formats: patch.formats } : {}),
        };
        subs.set(id, next);
        return next;
      }),
      delete: vi.fn(async (_t: string, id: string) => subs.delete(id)),
      findById: vi.fn(async (tenantId: string, id: string) => {
        const sub = subs.get(id);
        return sub && sub.tenant_id === tenantId ? sub : null;
      }),
      list: vi.fn(async () => [...subs.values()]),
    },
    reportsEnabled: vi.fn(async () => deps.flag),
    campaign: vi.fn(async (_req: unknown, id: string) =>
      id === CAMPAIGN ? { id: CAMPAIGN, name: 'Spring renewals', timezone: 'America/New_York' } : null),
    agentInAccount: vi.fn(async (userId: string) => userId === AGENT || userId === OTHER_AGENT),
    supervisorsAmong: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => id === SUPERVISOR))),
    ownedCampaignIds: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => id === CAMPAIGN))),
    names: vi.fn(async () => ({
      users: new Map<string, string | null>([[AGENT, 'Priya S'], [SUPERVISOR, 'Sam Supervisor']]),
      campaigns: new Map([[CAMPAIGN, 'Spring renewals']]),
      accounts: new Map([[ACCOUNT, 'North']]),
    })),
    presign: vi.fn(async (key: string) => `https://s3.example/${key}?sig=1`),
    // Postgres's zone database, as if it lacked one zone this process's ICU knows.
    zoneKnownToDatabase: vi.fn(async (zone: string) => zone !== ZONE_NOT_IN_POSTGRES),
    audit: vi.fn((entry: { action: string; resource_id?: string; details?: Record<string, unknown> }) => { audits.push(entry); }),
    now: () => NOW,
  };
  return { deps, runs, subs, audits };
}

let app: FastifyInstance;
let f: ReturnType<typeof fakeDeps>;
let caller: Caller;

async function build() {
  f = fakeDeps();
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = caller.tenantId ?? TENANT;
    r['accountId'] = caller.accountId ?? ACCOUNT;
    r['user'] = { id: caller.userId };
    r['membership'] = { role: caller.role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyReportsRoutes, {
    prefix: '/proxy/agency', ctx: null, deps: f.deps as unknown as Partial<ReportRouteDeps>,
  });
  await app.ready();
}

function req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  return app.inject({
    method, url,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
  });
}

const agentReview = (over: Record<string, unknown> = {}) => ({
  kind: 'agent', subject_id: AGENT, from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/London', formats: ['xlsx', 'pdf'], ...over,
});

beforeEach(async () => {
  caller = supervisor;
  await build();
});

const ROUTES: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
  ['POST', '/proxy/agency/reports'],
  ['GET', '/proxy/agency/reports'],
  ['GET', `/proxy/agency/reports/${RUN}`],
  ['GET', `/proxy/agency/reports/${RUN}/files/pdf`],
  ['POST', `/proxy/agency/reports/${RUN}/retry`],
  ['GET', '/proxy/agency/report-subscriptions'],
  ['POST', '/proxy/agency/report-subscriptions'],
  ['PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`],
  ['DELETE', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`],
  ['POST', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}/run-now`],
];

describe('the flag', () => {
  it('every route answers 403 feature_disabled (the dialer gate\'s body shape) with the flag off, before anything else', async () => {
    f.deps.flag = false;
    for (const [method, url] of ROUTES) {
      const res = await req(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json(), `${method} ${url}`).toEqual({
        error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Reports are not enabled for this account.',
      });
    }
    expect(f.deps.runs.findById).not.toHaveBeenCalled();
    expect(f.deps.runs.create).not.toHaveBeenCalled();
  });

  it('subscriptions are agency.supervise: an agent is refused by RBAC before the flag is read', async () => {
    caller = agent;
    for (const [method, url] of ROUTES.filter(([, u]) => u.includes('report-subscriptions'))) {
      const res = await req(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/^Insufficient permissions/);
    }
  });
});

describe('POST /reports: who may run what', () => {
  it('a supervisor\'s agent review is the supervisor audience; formats stored in contract order; 202 with the run', async () => {
    const res = await req('POST', '/proxy/agency/reports', agentReview());
    expect(res.statusCode).toBe(202);
    const run = res.json();
    expect(run).toMatchObject({
      kind: 'agent', subject: { id: AGENT, name: 'Priya S' }, account_id: ACCOUNT, audience: 'supervisor',
      status: 'queued', formats: ['pdf', 'xlsx'], range: { from: '2026-10-01', to: '2026-10-31', timezone: 'Europe/London' },
      requested_by: { user_id: SUPERVISOR, name: 'Sam Supervisor' }, subscription_id: null, files: [], error: null,
    });
    // October in London: from local midnight (BST, 23:00Z) to local midnight after the 31st (GMT).
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({
      rangeFrom: new Date('2026-09-30T23:00:00Z'), rangeTo: new Date('2026-11-01T00:00:00Z'), requestedBy: SUPERVISOR, emailMe: false,
    }), {
      pendingLimit: config.tenantPendingLimit,
      requesterRate: { limit: config.userPerMinute, since: new Date(NOW.getTime() - 60_000) },
    });
    expect(f.audits).toEqual([expect.objectContaining({
      action: 'agency_report.requested', resource_type: 'agency_report', resource_id: run.id,
      details: expect.objectContaining({ via: 'request', kind: 'agent', audience: 'supervisor' }),
    })]);
  });

  it('an agent may export their OWN review, with the self audience', async () => {
    caller = agent;
    const res = await req('POST', '/proxy/agency/reports', agentReview({ email_me: true }));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ audience: 'self', requested_by: { user_id: AGENT } });
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({ audience: 'self', emailMe: true }), LIMITS);
  });

  it('an agent may not export another agent\'s review: 403', async () => {
    caller = otherAgent;
    const res = await req('POST', '/proxy/agency/reports', agentReview());
    expect(res.statusCode).toBe(403);
    expect(f.deps.runs.create).not.toHaveBeenCalled();
  });

  it('an agent may not run a campaign or account report: 403', async () => {
    caller = agent;
    expect((await req('POST', '/proxy/agency/reports', agentReview({ kind: 'campaign', subject_id: CAMPAIGN }))).statusCode).toBe(403);
    expect((await req('POST', '/proxy/agency/reports', agentReview({ kind: 'account', subject_id: ACCOUNT }))).statusCode).toBe(403);
  });

  it('a supervisor\'s agent subject must be a member reaching the account: else 404 report_subject_not_found', async () => {
    const res = await req('POST', '/proxy/agency/reports', agentReview({ subject_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'report_subject_not_found' });
  });

  it('a campaign report is cut in the campaign\'s zone (the request\'s is ignored); an unowned campaign is 404', async () => {
    const res = await req('POST', '/proxy/agency/reports', agentReview({ kind: 'campaign', subject_id: CAMPAIGN, timezone: 'Asia/Tokyo' }));
    expect(res.statusCode).toBe(202);
    expect(res.json().range.timezone).toBe('America/New_York');
    const foreign = await req('POST', '/proxy/agency/reports', agentReview({ kind: 'campaign', subject_id: FOREIGN_CAMPAIGN }));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe('report_subject_not_found');
  });

  it('an account report is about the context account only; campaign_ids must be the account\'s', async () => {
    const ok = await req('POST', '/proxy/agency/reports', agentReview({ kind: 'account', subject_id: ACCOUNT, campaign_ids: [CAMPAIGN] }));
    expect(ok.statusCode).toBe(202);
    expect(f.deps.runs.create).toHaveBeenLastCalledWith(expect.objectContaining({ campaignIds: [CAMPAIGN] }), LIMITS);
    const other = await req('POST', '/proxy/agency/reports', agentReview({ kind: 'account', subject_id: OTHER_ACCOUNT }));
    expect(other.json()).toMatchObject({ code: 'report_subject_not_found' });
    const foreign = await req('POST', '/proxy/agency/reports', agentReview({ kind: 'account', subject_id: ACCOUNT, campaign_ids: [FOREIGN_CAMPAIGN] }));
    expect(foreign.statusCode).toBe(404);
  });
});

describe('POST /reports: validation', () => {
  it('a body that fails the schema is the generic agency 400', async () => {
    for (const body of [
      agentReview({ subject_id: 'not-a-uuid' }),
      agentReview({ formats: [] }),
      agentReview({ formats: ['pdf', 'pdf'] }),
      agentReview({ formats: ['docx'] }),
      agentReview({ kind: 'team' }),
      agentReview({ campaign_ids: [CAMPAIGN] }), // agent reports take no campaign_ids
      agentReview({ audience: 'self' }),         // the server decides the audience
    ]) {
      const res = await req('POST', '/proxy/agency/reports', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('Validation Error');
    }
  });

  it('the zone: required for agent and account, an IANA Area/Location (or UTC)', async () => {
    for (const timezone of [undefined, 'EST', 'Mars/Olympus', ' Europe/London', '']) {
      const res = await req('POST', '/proxy/agency/reports', agentReview({ timezone }));
      expect(res.statusCode, String(timezone)).toBe(400);
      expect(res.json().code).toBe('report_timezone_invalid');
    }
    expect((await req('POST', '/proxy/agency/reports', agentReview({ timezone: 'UTC' }))).statusCode).toBe(202);
  });

  it('the zone must also be in Postgres\'s zone database (the dataset reads cut days with AT TIME ZONE)', async () => {
    let res = await req('POST', '/proxy/agency/reports', agentReview({ timezone: ZONE_NOT_IN_POSTGRES }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('report_timezone_invalid');
    expect(f.deps.zoneKnownToDatabase).toHaveBeenCalledWith(ZONE_NOT_IN_POSTGRES);
    expect(f.deps.runs.create).not.toHaveBeenCalled();
    // A zone Intl refuses never reaches the database.
    f.deps.zoneKnownToDatabase.mockClear();
    await req('POST', '/proxy/agency/reports', agentReview({ timezone: 'Mars/Olympus' }));
    expect(f.deps.zoneKnownToDatabase).not.toHaveBeenCalled();
    // Subscriptions: create and a zone PATCH, the same rule.
    caller = supervisor;
    res = await req('POST', '/proxy/agency/report-subscriptions', {
      kind: 'agent', subject_id: AGENT, cadence: 'daily', send_local_time: '08:00', timezone: ZONE_NOT_IN_POSTGRES,
      formats: ['pdf'], recipient_user_ids: [SUPERVISOR],
    });
    expect(res.json().code).toBe('report_timezone_invalid');
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ kind: 'agent', subject_id: AGENT }));
    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { timezone: ZONE_NOT_IN_POSTGRES });
    expect(res.json().code).toBe('report_timezone_invalid');
    expect(f.deps.subscriptions.create).not.toHaveBeenCalled();
    expect(f.deps.subscriptions.update).not.toHaveBeenCalled();
  });

  it('the window rule (RP2): 30 days, or exactly one calendar month; not after today in the zone', async () => {
    const cases: Array<[string, string, number, string | null]> = [
      ['2026-10-01', '2026-10-30', 202, null],              // 30 days
      ['2026-10-01', '2026-10-31', 202, null],              // one whole month, 31 days
      ['2026-10-02', '2026-11-01', 400, 'report_window_too_long'], // 31 days, not a month
      ['2026-11-08', '2026-11-08', 202, null],              // today
      ['2026-11-08', '2026-11-09', 400, 'report_window_invalid'],  // tomorrow
      ['2026-10-31', '2026-10-01', 400, 'report_window_invalid'],
      ['2026-02-30', '2026-03-01', 400, 'report_window_invalid'],
      ['01/10/2026', '2026-10-31', 400, 'report_window_invalid'],
    ];
    for (const [from, to, status, code] of cases) {
      const res = await req('POST', '/proxy/agency/reports', agentReview({ from, to }));
      expect(res.statusCode, `${from}..${to}`).toBe(status);
      if (code) expect(res.json().code).toBe(code);
    }
  });

  it('"today" is the zone\'s: 9 Nov is already today at UTC+14 (Kiritimati) at 10:00Z on the 8th', async () => {
    expect((await req('POST', '/proxy/agency/reports', agentReview({ from: '2026-11-09', to: '2026-11-09', timezone: 'Pacific/Kiritimati' }))).statusCode).toBe(202);
    expect((await req('POST', '/proxy/agency/reports', agentReview({ from: '2026-11-09', to: '2026-11-09', timezone: 'America/New_York' }))).statusCode).toBe(400);
  });

  it('the per-user rate: past AGENCY_REPORTS_USER_PER_MINUTE in the last minute → 429 report_rate_limited', async () => {
    f.deps.recent = config.userPerMinute;
    const res = await req('POST', '/proxy/agency/reports', agentReview());
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: expect.any(String), code: 'report_rate_limited', message: expect.any(String) });
    // Counted by the repository inside the insert's transaction (not read first and then inserted).
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: SUPERVISOR, tenantId: TENANT }), expect.objectContaining({
      requesterRate: { limit: config.userPerMinute, since: new Date(NOW.getTime() - 60_000) },
    }));
    expect(f.audits).toEqual([]);
  });

  it('the tenant\'s pending limit → 429 report_queue_full', async () => {
    f.deps.queueFull = true;
    const res = await req('POST', '/proxy/agency/reports', agentReview());
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('report_queue_full');
    expect(f.audits).toEqual([]);
  });
});

describe('the tenant and account headers in upper case', () => {
  // The tenant middleware keeps the headers as sent; every stored id, and every id code compares
  // in JS (`reachesAccount`, the campaign probe), is lower case.
  beforeEach(() => {
    caller = { ...supervisor, tenantId: TENANT.toUpperCase(), accountId: ACCOUNT.toUpperCase() };
  });

  it('a run is created, checked and audited with the ids in lower case', async () => {
    const res = await req('POST', '/proxy/agency/reports', agentReview());
    expect(res.statusCode).toBe(202);
    expect(f.deps.agentInAccount).toHaveBeenCalledWith(AGENT, TENANT, ACCOUNT);
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT }), LIMITS);
    expect(f.audits[0]).toMatchObject({ tenant_id: TENANT, account_id: ACCOUNT });
    // The account report's subject is the context account, whatever its header's case.
    expect((await req('POST', '/proxy/agency/reports', agentReview({ kind: 'account', subject_id: ACCOUNT }))).statusCode).toBe(202);
  });

  it('the run, its download and the history are found under the lower-case ids', async () => {
    f.runs.set(RUN, runRecord({ status: 'ready', files: [{ format: 'pdf', key: 'k.pdf', bytes: 1 }], expires_at: new Date('2027-01-01T00:00:00Z') }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}`)).statusCode).toBe(200);
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(200);
    await req('GET', '/proxy/agency/reports');
    expect(f.deps.runs.list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT }));
  });

  it('subscriptions are created, listed, changed and run under the lower-case ids', async () => {
    const created = await req('POST', '/proxy/agency/report-subscriptions', {
      kind: 'campaign', subject_id: CAMPAIGN, cadence: 'daily', send_local_time: '08:00', formats: ['pdf'], recipient_user_ids: [SUPERVISOR],
    });
    expect(created.statusCode).toBe(201);
    expect(f.deps.supervisorsAmong).toHaveBeenCalledWith([SUPERVISOR], TENANT, ACCOUNT);
    expect(f.deps.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT }));
    await req('GET', '/proxy/agency/report-subscriptions');
    expect(f.deps.subscriptions.list).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { formats: ['xlsx'] })).statusCode).toBe(200);
    expect((await req('POST', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}/run-now`)).statusCode).toBe(202);
    expect((await req('DELETE', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`)).statusCode).toBe(204);
  });
});

describe('the history and one run', () => {
  it('a supervisor lists the account\'s runs; anyone else only their own, whatever the query says', async () => {
    await req('GET', `/proxy/agency/reports?kind=agent&subject_id=${AGENT}&limit=10`);
    expect(f.deps.runs.list).toHaveBeenLastCalledWith({
      tenantId: TENANT, accountId: ACCOUNT, kind: 'agent', subjectId: AGENT, limit: 10,
    });
    caller = agent;
    await req('GET', `/proxy/agency/reports?subject_id=${OTHER_AGENT}`);
    expect(f.deps.runs.list).toHaveBeenLastCalledWith(expect.objectContaining({ requestedBy: AGENT, subjectId: OTHER_AGENT }));
  });

  it('a cursor this API did not issue, or a limit past 100, is a 400', async () => {
    expect((await req('GET', '/proxy/agency/reports?cursor=garbage')).statusCode).toBe(400);
    expect((await req('GET', '/proxy/agency/reports?limit=101')).statusCode).toBe(400);
  });

  it('a run of another account, or one an agent did not request, is 404 report_not_found', async () => {
    f.runs.set(RUN, runRecord({ account_id: OTHER_ACCOUNT }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}`)).json().code).toBe('report_not_found');
    f.runs.set(RUN, runRecord({ requested_by: SUPERVISOR }));
    caller = agent;
    expect((await req('GET', `/proxy/agency/reports/${RUN}`)).statusCode).toBe(404);
    caller = supervisor;
    expect((await req('GET', `/proxy/agency/reports/${RUN}`)).statusCode).toBe(200);
    expect((await req('GET', '/proxy/agency/reports/not-a-uuid')).statusCode).toBe(404);
  });
});

describe('GET /reports/:id/files/:format', () => {
  const keyOf = (format: string) => `reports/${TENANT}/${ACCOUNT}/${RUN}/report.${format}`;
  const ready = (over: Partial<ReportRunRecord> = {}) => runRecord({
    status: 'ready', formats: ['pdf', 'xlsx'], finished_at: NOW, expires_at: new Date(NOW.getTime() + 86_400_000),
    files: [{ format: 'pdf', key: keyOf('pdf'), bytes: 10 }, { format: 'xlsx', key: keyOf('xlsx'), bytes: 20 }],
    local_from: '2026-10-09', local_to: '2026-11-07', ...over,
  });

  it('a ready file: a 5-minute presigned URL with the download name and content type, audited', async () => {
    f.runs.set(RUN, ready());
    const res = await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: `https://s3.example/${keyOf('pdf')}?sig=1`,
      filename: 'agent-review_priya-s_2026-10-09_2026-11-07.pdf',
      expires_at: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    expect(f.deps.presign).toHaveBeenCalledWith(keyOf('pdf'), {
      expiresIn: 300, filename: 'agent-review_priya-s_2026-10-09_2026-11-07.pdf', contentType: 'application/pdf',
    });
    expect(f.audits).toEqual([expect.objectContaining({ action: 'agency_report.downloaded', resource_id: RUN, details: expect.objectContaining({ format: 'pdf' }) })]);
  });

  it('not ready (in flight or failed) → 409; expired (or past expires_at) → 410; a format it lacks → 404', async () => {
    for (const status of ['queued', 'assembling', 'rendering', 'failed'] as const) {
      f.runs.set(RUN, ready({ status, files: [] }));
      const res = await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`);
      expect(res.statusCode, status).toBe(409);
      expect(res.json().code).toBe('report_not_ready');
    }
    f.runs.set(RUN, ready({ status: 'expired' }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).json()).toMatchObject({ code: 'report_expired' });
    f.runs.set(RUN, ready({ expires_at: new Date(NOW.getTime() - 1) }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/xlsx`)).statusCode).toBe(410);
    f.runs.set(RUN, ready({ formats: ['pdf'] }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/xlsx`)).json()).toMatchObject({ code: 'report_format_unavailable' });
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/docx`)).statusCode).toBe(404);
    expect(f.deps.presign).not.toHaveBeenCalled();
  });

  it('the requester may download; another agent may not (404); an agent may not download a supervisor review of them', async () => {
    f.runs.set(RUN, ready({ audience: 'self', requested_by: AGENT }));
    caller = agent;
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(200);
    caller = otherAgent;
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(404);
    f.runs.set(RUN, ready({ audience: 'supervisor', requested_by: SUPERVISOR }));
    caller = agent;
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(404);
  });

  it('a supervisor who did not request it may download while they could create it (a campaign run: the account still owns it)', async () => {
    const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    f.runs.set(RUN, ready({ kind: 'campaign', subject_id: CAMPAIGN, requested_by: other }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(200);
    f.runs.set(RUN, ready({ kind: 'campaign', subject_id: FOREIGN_CAMPAIGN, requested_by: other }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(404);
  });

  it('a requester demoted since may still see a supervisor run, but not download it (404); a self review stays its agent\'s', async () => {
    // Requested as a supervisor; the caller now holds only the agent role.
    const demoted: Caller = { userId: SUPERVISOR, role: 'agent' };
    for (const run of [
      ready({ requested_by: SUPERVISOR }),
      ready({ kind: 'campaign', subject_id: CAMPAIGN, requested_by: SUPERVISOR }),
      ready({ kind: 'account', subject_id: ACCOUNT, requested_by: SUPERVISOR }),
    ]) {
      f.runs.set(RUN, run);
      caller = demoted;
      expect((await req('GET', `/proxy/agency/reports/${RUN}`)).statusCode, run.kind).toBe(200);
      const res = await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`);
      expect(res.statusCode, run.kind).toBe(404);
      expect(res.json().code).toBe('report_not_found');
      caller = supervisor;
      expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode, run.kind).toBe(200);
    }
    expect(f.deps.presign).toHaveBeenCalledTimes(3);
  });

  it('a supervisor run about an agent whose membership no longer reaches the account: 404 even for its requester', async () => {
    f.runs.set(RUN, ready({ subject_id: FOREIGN_CAMPAIGN, requested_by: SUPERVISOR }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(404);
  });

  it('another account\'s run is 404 even for its requester', async () => {
    f.runs.set(RUN, ready({ account_id: OTHER_ACCOUNT }));
    expect((await req('GET', `/proxy/agency/reports/${RUN}/files/pdf`)).statusCode).toBe(404);
  });
});

describe('POST /reports/:id/retry', () => {
  it('is a NEW ad hoc run with the same parameters, requested by the caller', async () => {
    f.runs.set(RUN, runRecord({ status: 'failed', kind: 'account', subject_id: ACCOUNT, campaign_ids: [CAMPAIGN], requested_by: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email_me: true }));
    const res = await req('POST', `/proxy/agency/reports/${RUN}/retry`);
    expect(res.statusCode).toBe(202);
    expect(res.json().id).not.toBe(RUN);
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'account', subjectId: ACCOUNT, campaignIds: [CAMPAIGN], localFrom: '2026-10-01', localTo: '2026-10-31',
      requestedBy: SUPERVISOR, emailMe: false,
    }), LIMITS);
    expect(f.audits[0]).toMatchObject({ details: expect.objectContaining({ via: 'retry' }) });
  });

  it('re-checks the caller\'s permission: an agent re-running their own review gets self; another\'s run is 404', async () => {
    f.runs.set(RUN, runRecord({ audience: 'self', requested_by: AGENT, email_me: true }));
    caller = agent;
    const res = await req('POST', `/proxy/agency/reports/${RUN}/retry`);
    expect(res.statusCode).toBe(202);
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({ audience: 'self', emailMe: true }), LIMITS);
    caller = otherAgent;
    expect((await req('POST', `/proxy/agency/reports/${RUN}/retry`)).statusCode).toBe(404);
  });

  it('applies the rate limit like a new request', async () => {
    f.runs.set(RUN, runRecord());
    f.deps.recent = 99;
    expect((await req('POST', `/proxy/agency/reports/${RUN}/retry`)).json().code).toBe('report_rate_limited');
  });
});

describe('subscriptions', () => {
  const daily = (over: Record<string, unknown> = {}) => ({
    kind: 'campaign', subject_id: CAMPAIGN, cadence: 'daily', send_local_time: '08:00', formats: ['pdf'],
    recipient_user_ids: [SUPERVISOR], ...over,
  });

  it('creates one: 201, the campaign\'s zone, next_run_at the next send, audited', async () => {
    const res = await req('POST', '/proxy/agency/report-subscriptions', daily({ timezone: 'Asia/Tokyo' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'campaign', subject: { id: CAMPAIGN, name: 'Spring renewals' }, timezone: 'America/New_York',
      cadence: 'daily', send_local_time: '08:00', enabled: true, recipients: [{ user_id: SUPERVISOR, name: 'Sam Supervisor' }],
      created_by: { user_id: SUPERVISOR }, last_run: null,
    });
    // 08:00 New York (EST, UTC-5) after 10:00Z on 8 Nov is 13:00Z on the 8th.
    expect(res.json().next_run_at).toBe('2026-11-08T13:00:00.000Z');
    expect(f.audits[0]).toMatchObject({ action: 'agency_report_subscription.created', resource_type: 'agency_report_subscription' });
  });

  it('a disabled one has no next_run_at', async () => {
    const res = await req('POST', '/proxy/agency/report-subscriptions', daily({ enabled: false }));
    expect(res.json()).toMatchObject({ enabled: false, next_run_at: null });
  });

  it('day fields must match the cadence; the time must be HH:MM → 400 report_subscription_invalid', async () => {
    for (const body of [
      daily({ cadence: 'weekly' }),
      daily({ cadence: 'weekly', send_weekday: 8 }),
      daily({ send_weekday: 1 }),
      daily({ cadence: 'monthly', send_monthday: 29 }),
      daily({ cadence: 'monthly', send_monthday: 1, send_weekday: 3 }),
      daily({ send_local_time: '24:00' }),
      daily({ send_local_time: '8:00' }),
    ]) {
      const res = await req('POST', '/proxy/agency/report-subscriptions', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe('report_subscription_invalid');
    }
    expect((await req('POST', '/proxy/agency/report-subscriptions', daily({ cadence: 'weekly', send_weekday: 1 }))).statusCode).toBe(201);
  });

  it('recipients: supervisors of the account only, at most 20 → 400 report_recipient_invalid', async () => {
    const notSup = await req('POST', '/proxy/agency/report-subscriptions', daily({ recipient_user_ids: [SUPERVISOR, AGENT] }));
    expect(notSup.json()).toMatchObject({ code: 'report_recipient_invalid' });
    const many = Array.from({ length: 21 }, (_, i) => `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`);
    expect((await req('POST', '/proxy/agency/report-subscriptions', daily({ recipient_user_ids: many }))).json().code).toBe('report_recipient_invalid');
  });

  it('an agent subscription is a supervisor\'s, and needs a zone', async () => {
    expect((await req('POST', '/proxy/agency/report-subscriptions', daily({ kind: 'agent', subject_id: AGENT }))).json().code).toBe('report_timezone_invalid');
    expect((await req('POST', '/proxy/agency/report-subscriptions', daily({ kind: 'agent', subject_id: AGENT, timezone: 'Europe/London' }))).statusCode).toBe(201);
  });

  /** The fake campaign probe answers with the campaign in `zone` (it is in New York by default). */
  const campaignIn = (zone: string) => f.deps.campaign.mockResolvedValue({ id: CAMPAIGN, name: 'Spring renewals', timezone: zone });

  it('PATCH: disabling clears next_run_at; a schedule change recomputes it; a formats-only edit keeps it', async () => {
    campaignIn('Europe/London');
    f.subs.set(SUBSCRIPTION, subscriptionRecord());
    let res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { formats: ['xlsx', 'pdf'] });
    expect(res.statusCode).toBe(200);
    expect(f.deps.subscriptions.update.mock.calls[0]![2]).not.toHaveProperty('nextRunAt');
    expect(f.deps.subscriptions.update.mock.calls[0]![2]).toMatchObject({ formats: ['pdf', 'xlsx'] });

    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: false });
    expect(res.json()).toMatchObject({ enabled: false, next_run_at: null });

    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true, cadence: 'weekly', send_weekday: 1 });
    expect(res.statusCode).toBe(200);
    // Monday 9 Nov 08:00 London (GMT).
    expect(res.json().next_run_at).toBe('2026-11-09T08:00:00.000Z');
    expect(f.audits.at(-1)).toMatchObject({ action: 'agency_report_subscription.updated', details: { fields: ['cadence', 'enabled', 'send_weekday'], enabled: true } });
  });

  it('PATCH: the whole unchanged schedule re-sent (as the console does) with a formats edit keeps next_run_at; fields name only what changed', async () => {
    campaignIn('Europe/London');
    const due = new Date('2026-11-08T08:00:00Z'); // due before NOW: the tick has not sent it yet
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ next_run_at: due }));
    const whole = {
      cadence: 'daily', send_local_time: '08:00', send_weekday: null, send_monthday: null, timezone: 'Europe/London',
      recipient_user_ids: [SUPERVISOR], enabled: true,
    };
    let res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { ...whole, formats: ['pdf', 'xlsx'] });
    expect(res.statusCode).toBe(200);
    expect(f.deps.subscriptions.update.mock.calls[0]![2]).not.toHaveProperty('nextRunAt');
    expect(res.json().next_run_at).toBe(due.toISOString());
    expect(f.audits.at(-1)).toMatchObject({ details: { fields: ['formats'], enabled: true } });

    // `enabled: true` on an enabled subscription, nothing else changed: nothing recomputed, no field named.
    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true });
    expect(f.deps.subscriptions.update.mock.calls[1]![2]).not.toHaveProperty('nextRunAt');
    expect(f.audits.at(-1)).toMatchObject({ details: { fields: [] } });

    // A real change of the send time does recompute it.
    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { ...whole, formats: ['pdf', 'xlsx'], send_local_time: '11:00' });
    expect(f.deps.subscriptions.update.mock.calls[2]![2]).toMatchObject({ nextRunAt: new Date('2026-11-08T11:00:00Z') });
    expect(f.audits.at(-1)).toMatchObject({ details: { fields: ['send_local_time'] } });
  });

  it('PATCH re-enabling resolves the subject as POST does: a campaign deleted since is 404 report_subject_not_found, nothing stored', async () => {
    // The tick disabled it at a send because its campaign was gone (the fake probe knows CAMPAIGN only).
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ subject_id: FOREIGN_CAMPAIGN, enabled: false, next_run_at: null }));
    const res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'report_subject_not_found' });
    expect(f.deps.campaign).toHaveBeenCalledWith(expect.anything(), FOREIGN_CAMPAIGN);
    expect(f.deps.subscriptions.update).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);

    // An edit that leaves it disabled needs no subject (it cuts no send): formats, or the schedule.
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { formats: ['xlsx'] })).statusCode).toBe(200);
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { send_local_time: '09:00' })).statusCode).toBe(200);
    // Nor does disabling an enabled one whose subject is gone, or a formats edit while it is enabled.
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ subject_id: FOREIGN_CAMPAIGN }));
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { formats: ['xlsx'] })).statusCode).toBe(200);
    // A schedule change on an enabled one cuts a new send, so it resolves the subject too.
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { send_local_time: '09:00' })).json().code)
      .toBe('report_subject_not_found');
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: false })).statusCode).toBe(200);
  });

  it('PATCH re-enabling an agent subscription whose agent no longer reaches the account: 404 report_subject_not_found', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ kind: 'agent', subject_id: AGENT, enabled: false, next_run_at: null }));
    f.deps.agentInAccount.mockResolvedValue(false);
    const res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true });
    expect(res.json()).toMatchObject({ code: 'report_subject_not_found' });
    expect(f.deps.subscriptions.update).not.toHaveBeenCalled();
    f.deps.agentInAccount.mockResolvedValue(true);
    const ok = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true });
    expect(ok.statusCode).toBe(200);
    // An agent subscription keeps its own zone: 08:00 London after 10:00Z on the 8th is the 9th.
    expect(ok.json()).toMatchObject({ enabled: true, timezone: 'Europe/London', next_run_at: '2026-11-09T08:00:00.000Z' });
  });

  it('PATCH re-enabling a campaign subscription cuts next_run_at in the campaign\'s CURRENT zone and stores that zone (RP3)', async () => {
    // Stored while the campaign was in Kolkata; it has moved to New York since (the fake probe).
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ timezone: 'Asia/Kolkata', enabled: false, next_run_at: null }));
    const res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true });
    expect(res.statusCode).toBe(200);
    // 08:00 New York (EST) after 10:00Z on the 8th is 13:00Z on the 8th; 08:00 Kolkata would be 02:30Z on the 9th.
    expect(res.json()).toMatchObject({ enabled: true, timezone: 'America/New_York', next_run_at: '2026-11-08T13:00:00.000Z' });
    expect(f.deps.subscriptions.update.mock.calls[0]![2]).toMatchObject({
      timezone: 'America/New_York', enabled: true, nextRunAt: new Date('2026-11-08T13:00:00Z'),
    });
    expect(f.audits.at(-1)).toMatchObject({ details: { fields: ['enabled', 'timezone'], enabled: true } });
  });

  it('PATCH re-enabling a campaign whose current zone Postgres cannot cut days in: 400 report_timezone_invalid, as POST', async () => {
    campaignIn(ZONE_NOT_IN_POSTGRES);
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ enabled: false, next_run_at: null }));
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: true })).json().code)
      .toBe('report_timezone_invalid');
    expect(f.deps.subscriptions.update).not.toHaveBeenCalled();
  });

  it('PATCH: the day fields are checked against the resulting cadence', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ cadence: 'weekly', send_weekday: 3 }));
    // Switching to daily drops the weekday it no longer uses.
    let res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { cadence: 'daily' });
    expect(res.statusCode).toBe(200);
    expect(f.deps.subscriptions.update.mock.calls[0]![2]).toMatchObject({ sendWeekday: null });
    // Switching to monthly without a monthday is refused.
    res = await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { cadence: 'monthly' });
    expect(res.json().code).toBe('report_subscription_invalid');
  });

  it('another account\'s subscription is 404 report_subscription_not_found for PATCH, DELETE and run-now', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ account_id: OTHER_ACCOUNT }));
    expect((await req('PATCH', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`, { enabled: false })).json().code).toBe('report_subscription_not_found');
    expect((await req('DELETE', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`)).statusCode).toBe(404);
    expect((await req('POST', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}/run-now`)).statusCode).toBe(404);
    expect(f.deps.subscriptions.delete).not.toHaveBeenCalled();
  });

  it('DELETE: 204 and audited', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord());
    const res = await req('DELETE', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}`);
    expect(res.statusCode).toBe(204);
    expect(f.audits[0]).toMatchObject({ action: 'agency_report_subscription.deleted', resource_id: SUBSCRIPTION });
  });

  it('run-now: an AD HOC run of the latest complete period, by the caller, emailed to them, supervisor audience', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ cadence: 'monthly', send_monthday: 1, kind: 'account', subject_id: ACCOUNT }));
    const res = await req('POST', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}/run-now`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ subscription_id: null, requested_by: { user_id: SUPERVISOR }, audience: 'supervisor' });
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({
      localFrom: '2026-10-01', localTo: '2026-10-31', requestedBy: SUPERVISOR, emailMe: true, audience: 'supervisor',
    }), LIMITS);
    expect(f.audits[0]).toMatchObject({ details: expect.objectContaining({ via: 'run_now', subscription_id: SUBSCRIPTION }) });
  });

  it('run-now on a campaign subscription cuts the period in the campaign\'s CURRENT zone, the zone the run is stored with', async () => {
    // Stored when the campaign was in Kiritimati (UTC+14, where 10:00Z on the 8th is already the 9th);
    // the campaign is in New York now (the fake probe), where it is 05:00 on the 8th.
    f.subs.set(SUBSCRIPTION, subscriptionRecord({ timezone: 'Pacific/Kiritimati' }));
    const res = await req('POST', `/proxy/agency/report-subscriptions/${SUBSCRIPTION}/run-now`);
    expect(res.statusCode).toBe(202);
    expect(f.deps.runs.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'campaign', timezone: 'America/New_York', localFrom: '2026-11-07', localTo: '2026-11-07',
      rangeFrom: new Date('2026-11-07T05:00:00Z'), rangeTo: new Date('2026-11-08T05:00:00Z'),
    }), LIMITS);
  });

  it('GET lists the account\'s subscriptions with names', async () => {
    f.subs.set(SUBSCRIPTION, subscriptionRecord());
    const res = await req('GET', '/proxy/agency/report-subscriptions');
    expect(res.json().subscriptions).toEqual([expect.objectContaining({ id: SUBSCRIPTION, subject: { id: CAMPAIGN, name: 'Spring renewals' } })]);
    expect(f.deps.subscriptions.list).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });
});
