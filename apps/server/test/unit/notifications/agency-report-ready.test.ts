// The report-ready email (`agency.report.ready`): its copy (British English, ready and failed,
// scheduled and ad hoc), its one link (the run page, scoped to the run's tenant and account) and
// who it goes to (the requester only with `email_me`; a subscription's recipients re-checked
// against RBAC at send time, those without access skipped and counted; each user's preference;
// one claim per run and recipient). Transport, ledger and repositories are fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  emails: vi.fn(),
  sendEmail: vi.fn(async (_params: { to: Array<{ email: string }>; subject: string }) => true),
  claim: vi.fn(async (input: { recipients: string[] }) => input.recipients.map((r, i) => ({ id: `d${i}`, recipient: r }))),
  recordOutcome: vi.fn(async () => {}),
  prefs: vi.fn(async () => [] as Array<{ user_id: string; enabled: boolean }>),
  findSub: vi.fn(),
  members: vi.fn(),
  identities: vi.fn(),
  config: {
    mailjet: { apiKey: 'k' } as unknown,
    brand: { name: 'Magick Agency', accent: '#7c5cfc' },
    consoleBaseUrl: 'https://console.example.com/' as string | undefined,
  },
}));

vi.mock('@magick-agency/observability/metrics/agency', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agencyReportsEmailsTotal: { inc: m.emails },
}));
vi.mock('../../../src/config/index.js', () => ({ config: m.config }));
vi.mock('../../../src/notifications/mailjet.client.js', () => ({ sendEmail: m.sendEmail }));
vi.mock('../../../src/db/repositories/notification-delivery.repository.js', () => ({
  notificationDeliveryRepository: { claim: m.claim, recordOutcome: m.recordOutcome },
}));
vi.mock('../../../src/db/repositories/notification-preference.repository.js', () => ({
  notificationPreferenceRepository: { findForUsersAndEvent: m.prefs },
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findAnyByUsersAndTenant: m.members },
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findIdentitiesInTenant: m.identities },
}));
vi.mock('../../../src/agency/reports/run-view.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveReportNames: async () => ({ users: new Map([['55555555-5555-4555-8555-555555555555', 'Priya S']]), campaigns: new Map(), accounts: new Map() }),
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  reportSubscriptionRepository: { findById: m.findSub },
  agencyCampaignRepository: {},
}));

import { renderReportReadyEmail, reportRunUrl } from '../../../src/notifications/templates/agency-report-ready.template.js';
import { sendAgencyReportReadyEmails } from '../../../src/notifications/agency-report-ready.js';
import { ACCOUNT, AGENT, RUN, SUBSCRIPTION, SUPERVISOR, TENANT, runRecord, subscriptionRecord } from '../agency/reports/run-fixture.js';

const OTHER = '99999999-9999-4999-8999-999999999999';
const member = (user_id: string, role: string, account_id: string | null = ACCOUNT, status = 'active') =>
  ({ user_id, role, account_id, status, tenant_id: TENANT });

const base = {
  tenantId: TENANT, accountId: ACCOUNT, runId: RUN, kind: 'agent' as const, subjectName: 'Priya S',
  from: '2026-10-09', to: '2026-11-07', timezone: 'Europe/London', outcome: 'ready' as const,
  truncated: false, scheduled: false, retentionDays: 90, brandName: 'Magick Agency',
};

describe('renderReportReadyEmail', () => {
  it('a ready agent review: subject, window, the run link scoped to its tenant and account', () => {
    const email = renderReportReadyEmail(base, 'https://console.example.com/');
    expect(email.subject).toBe('Your agent review for Priya S is ready');
    expect(email.url).toBe(`https://console.example.com/t/${TENANT}/a/${ACCOUNT}/agency/reports/${RUN}`);
    expect(email.textBody).toContain('covering 9 Oct 2026 to 7 Nov 2026 (Europe/London), is ready to download.');
    expect(email.textBody).toContain(`Open the report: ${email.url}`);
    expect(email.textBody).toContain('downloaded for 90 days');
    expect(email.htmlBody).toContain(`href="${email.url}"`);
  });

  it('a failed run "could not be prepared", with the way to run it again', () => {
    const email = renderReportReadyEmail({ ...base, kind: 'campaign', subjectName: 'Spring renewals', outcome: 'failed' }, 'https://c.example');
    expect(email.subject).toBe('Your campaign report for Spring renewals could not be prepared');
    expect(email.textBody).toContain('Open the report to see why and to run it again.');
  });

  it('a scheduled account report says so; a truncated one says its sheets were cut short', () => {
    const email = renderReportReadyEmail({ ...base, kind: 'account', subjectName: 'North', scheduled: true, truncated: true, from: '2026-11-07', to: '2026-11-07' }, undefined);
    expect(email.subject).toBe('Your scheduled account report for North is ready');
    expect(email.textBody).toContain('covering 7 Nov 2026 (Europe/London)');
    expect(email.textBody).toContain('cut short');
    expect(email.url).toBeNull();
    expect(email.htmlBody).not.toContain('href=');
  });

  it('escapes a subject name in the HTML', () => {
    const email = renderReportReadyEmail({ ...base, subjectName: '<b>Eve</b>' }, 'https://c.example');
    expect(email.htmlBody).not.toContain('<b>Eve</b>');
    expect(email.htmlBody).toContain('&lt;b&gt;Eve&lt;/b&gt;');
  });

  it('the link is unscoped for a run with no account, and null with no console origin', () => {
    expect(reportRunUrl({ tenantId: TENANT, accountId: null, runId: RUN }, 'https://c.example')).toBe(`https://c.example/agency/reports/${RUN}`);
    expect(reportRunUrl({ tenantId: TENANT, accountId: ACCOUNT, runId: RUN }, undefined)).toBeNull();
  });
});

describe('sendAgencyReportReadyEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.config.mailjet = { apiKey: 'k' };
    m.prefs.mockResolvedValue([]);
    m.identities.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, email: `${id.slice(0, 4)}@x.example`, display_name: null, role: 'agent' })));
  });

  it('an ad hoc run emails its requester only when they asked (email_me)', async () => {
    m.members.mockResolvedValue([member(AGENT, 'agent')]);
    const quiet = await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: false }), { retentionDays: 90 });
    expect(quiet).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(m.sendEmail).not.toHaveBeenCalled();

    const counts = await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true, audience: 'self' }), { retentionDays: 90 });
    expect(counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(m.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: [{ email: '5555@x.example' }], subject: 'Your agent review for Priya S is ready',
    }));
    expect(m.claim).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: 'agency.report.ready', dedupeKey: `report:${RUN}`, tenantId: TENANT, accountId: ACCOUNT,
    }));
    expect(m.emails).toHaveBeenCalledWith({ result: 'sent' }, 1);
  });

  it('a subscription\'s run goes to the recipients who still supervise the account; the others are skipped and counted', async () => {
    m.findSub.mockResolvedValue(subscriptionRecord({ recipient_user_ids: [SUPERVISOR, OTHER, AGENT] }));
    m.members.mockResolvedValue([
      member(SUPERVISOR, 'account_admin'),
      member(OTHER, 'account_admin', '33333333-3333-4333-8333-333333333333'), // another account's admin
      member(AGENT, 'agent'),                                                   // never a supervisor
    ]);
    const counts = await sendAgencyReportReadyEmails(runRecord({ status: 'ready', subscription_id: SUBSCRIPTION, requested_by: null }), { retentionDays: 90 });
    expect(counts).toEqual({ sent: 1, skipped: 2, failed: 0 });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toMatchObject({ subject: 'Your scheduled agent review for Priya S is ready' });
    expect(m.emails).toHaveBeenCalledWith({ result: 'skipped' }, 2);
  });

  it('a revoked membership no longer counts; a tenant admin reaches every account', async () => {
    m.findSub.mockResolvedValue(subscriptionRecord({ recipient_user_ids: [SUPERVISOR, OTHER] }));
    m.members.mockResolvedValue([member(SUPERVISOR, 'account_admin', ACCOUNT, 'revoked'), member(OTHER, 'tenant_admin', null)]);
    const counts = await sendAgencyReportReadyEmails(runRecord({ status: 'failed', subscription_id: SUBSCRIPTION }), { retentionDays: 90 });
    expect(counts).toEqual({ sent: 1, skipped: 1, failed: 0 });
  });

  it('a deleted subscription sends nothing and counts one skip', async () => {
    m.findSub.mockResolvedValue(null);
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', subscription_id: SUBSCRIPTION }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('respects a user who turned the event off', async () => {
    m.members.mockResolvedValue([member(AGENT, 'agent')]);
    m.prefs.mockResolvedValue([{ user_id: AGENT, enabled: false }]);
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('an already-claimed recipient is skipped (never a second email); a failed claim withholds and counts failed', async () => {
    m.members.mockResolvedValue([member(AGENT, 'agent')]);
    m.claim.mockResolvedValueOnce([]);
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 1, failed: 0 });
    m.claim.mockRejectedValueOnce(new Error('db down'));
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('without a mail transport every eligible recipient is skipped', async () => {
    m.config.mailjet = undefined;
    m.members.mockResolvedValue([member(AGENT, 'agent')]);
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('a refused send is counted failed', async () => {
    m.members.mockResolvedValue([member(AGENT, 'agent')]);
    m.sendEmail.mockResolvedValueOnce(false);
    expect(await sendAgencyReportReadyEmails(runRecord({ status: 'ready', requested_by: AGENT, email_me: true }), { retentionDays: 90 }))
      .toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(m.recordOutcome).toHaveBeenCalledWith('d0', 'failed', expect.any(String));
  });
});
