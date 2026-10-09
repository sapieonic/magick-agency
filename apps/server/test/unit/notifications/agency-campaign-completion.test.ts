import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The agency campaign-completion notice (E10).
 *
 * ── What is actually worth pinning here ─────────────────────────────────────
 * Not "an email is composed" — that is the easy half and it is the same shape as
 * the bulk-dispatch mailer this file was modelled on. Three things:
 *
 *  1. **The destination.** The one requirement stated outright is
 *     that this must NOT reuse the bulk-dispatch mailer's primary-app deep link.
 *     A link into `/app/…` in an email is the scope leak this whole scope
 *     isolation exists to remove, and worse than a leak in the SPA: an inbox
 *     outlives every redirect we would later add to cover for it. So the link is
 *     asserted positively (`/agency/campaigns/:id`) and negatively (no `/app/`,
 *     no `/admin/`).
 *  2. **The audience.** The server holds no agency campaign row and the campaign
 *     carries no notification list, so the recipients are DERIVED from
 *     membership at the `agency.supervise` floor. The case that matters is the
 *     exclusion: an `agent` is level 5 and must not be mailed, because the
 *     alternative anybody reaches for is raising that level — the single most
 *     tempting shortcut in this scope, and never the answer.
 *  3. **Totality and the env gate.** A webhook handler has already acknowledged
 *     the campaign's terminal status by the time this runs, so a throw here
 *     would turn a delivered fact into a redelivered one for the sake of an
 *     email. Every failure has to come back as a reason — and the reasons have to
 *     stay distinguishable, which is why `account_not_addressable` is asserted
 *     apart from `no_recipients`.
 *  4. **The audience is derived, so it must not be disclosed.** One envelope per
 *     recipient. A single `To:` would show every supervisor the account's admin
 *     roster, which is the server publishing membership rather than echoing a list the
 *     tenant typed itself.
 *
 * `src/config/index.js` is mocked per case, as `invite-mailer.test.ts` does and
 * for the same reason: it is the module that decides whether the subsystem
 * exists at all, and config is frozen at import so mutating `process.env`
 * afterwards would prove nothing.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sendEmail: vi.fn(),
  findAddressableMembersInAccount: vi.fn(),
  /**
   * The account-existence lookup. Mocked rather than left real because the
   * addressability question is now answered against `accounts`, not against a
   * regex — see `isAccountUnaddressable`.
   */
  findByIdInTenant: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  /**
   * The delivery ledger. Mocked because this mailer now CLAIMS before it sends:
   * webhooks are redelivered as a matter of routine and `dispatchWebhook` retries
   * a 5s timeout three times, so without a claim the day the emitter lands is
   * the day supervisors get the same notice several times.
   *
   * Default in `beforeEach` is claim-everything, which is the ordinary
   * first-delivery path every case below was written about.
   */
  claim: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('../../../src/notifications/mailjet.client.js', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findAddressableMembersInAccount: mocks.findAddressableMembersInAccount },
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findByIdInTenant: mocks.findByIdInTenant },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));
vi.mock('../../../src/db/repositories/notification-delivery.repository.js', () => ({
  notificationDeliveryRepository: { claim: mocks.claim, recordOutcome: mocks.recordOutcome },
}));

import {
  agencyCampaignUrl,
  renderAgencyCampaignCompletionEmail,
  resolveCampaignNotificationRecipients,
  sendAgencyCampaignCompletionEmail,
  type AgencyCampaignCompletion,
} from '../../../src/notifications/agency-campaign-completion.js';

/** Replace the mocked config wholesale; the module reads it per call. */
function setConfig(next: Record<string, unknown>) {
  for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  Object.assign(mocks.config, next);
}

const MAILJET = { apiKey: 'k', apiSecret: 's', fromEmail: 'no-reply@example.com', fromName: 'Sapionic' };

const completion: AgencyCampaignCompletion = {
  tenantId: TENANT,
  accountId: ACCOUNT,
  campaignId: CAMPAIGN,
  status: 'completed',
  campaignName: 'Q3 Renewals',
  completedAt: '2026-08-24T10:00:00.000Z',
  contactsTotal: 5000,
  contactsCompleted: 4980,
  attempts: 7412,
  connects: 812,
};

beforeEach(() => {
  vi.clearAllMocks();
  setConfig({ mailjet: MAILJET, consoleBaseUrl: 'https://app.example.com' });
  mocks.sendEmail.mockResolvedValue(true);
  mocks.findAddressableMembersInAccount.mockResolvedValue([
    { email: 'supervisor@example.com', role: 'account_admin' },
  ]);
  // The default is an account that EXISTS. Every case that cares about the
  // opposite says so explicitly, so a case that stopped resolving would be
  // visible rather than inherited.
  mocks.findByIdInTenant.mockResolvedValue({ id: ACCOUNT, tenant_id: TENANT });
  // Claim everything offered — the first-delivery path. The ledger lower-cases
  // the addresses it claims, so the stub echoes what it was handed.
  mocks.claim.mockImplementation(async (arg: { recipients: string[] }) =>
    arg.recipients.map((recipient, i) => ({ id: `d${i}`, recipient })),
  );
  mocks.recordOutcome.mockResolvedValue(undefined);
});

describe('the deep link', () => {
  it('lands inside the agency shell, on the campaign the notice is about', () => {
    expect(agencyCampaignUrl(CAMPAIGN, 'https://app.example.com'))
      .toBe(`https://app.example.com/agency/campaigns/${CAMPAIGN}`);
  });

  /**
   * The one explicit requirement for this item. `/app/…` is the AI
   * application's shell and `/admin/…` is where the bulk-dispatch mailer points
   * (a path the console does not even route today) — neither may appear in an agency
   * campaign notice, in either body.
   */
  it('never points into the primary application from either body', () => {
    const mail = renderAgencyCampaignCompletionEmail(completion, 'https://app.example.com');
    for (const body of [mail.textBody, mail.htmlBody]) {
      expect(body).toContain(`/agency/campaigns/${CAMPAIGN}`);
      expect(body).not.toContain('/app/');
      expect(body).not.toContain('/admin/');
    }
  });

  it('trims a trailing slash on the configured origin rather than doubling it', () => {
    expect(agencyCampaignUrl(CAMPAIGN, 'https://app.example.com/'))
      .toBe(`https://app.example.com/agency/campaigns/${CAMPAIGN}`);
  });

  it('is null with no configured origin, rather than a guessed one', () => {
    expect(agencyCampaignUrl(CAMPAIGN, undefined)).toBeNull();
  });
});

describe('the rendered notice', () => {
  it('names the campaign and its terminal status in the subject', () => {
    const mail = renderAgencyCampaignCompletionEmail(completion, 'https://app.example.com');
    expect(mail.subject).toBe('[Sapionic] Campaign "Q3 Renewals" — Completed');
  });

  /**
   * `stopped` is a supervisor's decision and `completed` is the roster running
   * out. Collapsing them would tell a supervisor their campaign finished when
   * they are the one who ended it.
   */
  it('keeps stopped and completed apart', () => {
    const mail = renderAgencyCampaignCompletionEmail({ ...completion, status: 'stopped' }, undefined);
    expect(mail.subject).toContain('Stopped');
    expect(mail.textBody).toContain('Status: Stopped');
  });

  it('falls back to a short id for an unnamed campaign', () => {
    const mail = renderAgencyCampaignCompletionEmail({ ...completion, campaignName: '   ' }, undefined);
    expect(mail.subject).toContain(`"${CAMPAIGN.slice(0, 8)}"`);
  });

  /**
   * The server cannot count a campaign's roster, so a caller may legitimately
   * have no numbers. An omitted count must not render as 0 — that is a claim
   * about the campaign, and a false one.
   */
  it('omits a count it was not given instead of showing zero', () => {
    const mail = renderAgencyCampaignCompletionEmail(
      { tenantId: TENANT, campaignId: CAMPAIGN, status: 'completed' },
      undefined,
    );
    expect(mail.textBody).not.toContain('Connected Calls');
    expect(mail.textBody).not.toContain('Contacts');
    expect(mail.htmlBody).not.toContain('Dial Attempts');
    // Status and the end time are unconditional: they are the notice.
    expect(mail.textBody).toContain('Status: Completed');
    expect(mail.textBody).toContain('Ended At: N/A');
  });

  /** Still worth sending: the news is in the subject, the link accelerates it. */
  it('renders without a link when no origin is configured', () => {
    const mail = renderAgencyCampaignCompletionEmail(completion, undefined);
    expect(mail.textBody).not.toContain('View campaign:');
    expect(mail.htmlBody).not.toContain('<a href');
    expect(mail.subject).toContain('Q3 Renewals');
  });

  it('escapes a campaign name that carries markup', () => {
    const mail = renderAgencyCampaignCompletionEmail(
      { ...completion, campaignName: '<script>x</script>' },
      undefined,
    );
    expect(mail.htmlBody).not.toContain('<script>');
    expect(mail.htmlBody).toContain('&lt;script&gt;');
  });
});

describe('who gets told', () => {
  /**
   * The exclusion is the point. `agent` is hierarchy level 5, below `viewer`,
   * deliberately — and the way to serve an agent is an agency-native surface,
   * never a raised level (`src/rbac/roles.ts`).
   */
  it('mails supervisors and above, and never an agent, viewer or operator', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'agent@example.com', role: 'agent' },
      { email: 'viewer@example.com', role: 'viewer' },
      { email: 'operator@example.com', role: 'operator' },
      { email: 'account-admin@example.com', role: 'account_admin' },
      { email: 'tenant-admin@example.com', role: 'tenant_admin' },
      { email: 'owner@example.com', role: 'tenant_owner' },
    ]);

    const recipients = await resolveCampaignNotificationRecipients(TENANT, ACCOUNT);
    expect(recipients.sort()).toEqual([
      'account-admin@example.com',
      'owner@example.com',
      'tenant-admin@example.com',
    ]);
  });

  /** One person, two memberships (account-scoped plus tenant-level), one inbox. */
  it('de-duplicates an address held by two memberships', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'both@example.com', role: 'account_admin' },
      { email: 'both@example.com', role: 'tenant_owner' },
    ]);
    expect(await resolveCampaignNotificationRecipients(TENANT, ACCOUNT)).toEqual(['both@example.com']);
  });

  it('ignores a role the server does not recognise rather than assuming it qualifies', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'mystery@example.com', role: 'future_role' },
    ]);
    expect(await resolveCampaignNotificationRecipients(TENANT, ACCOUNT)).toEqual([]);
  });
});

describe('sending', () => {
  it('sends the rendered notice to every resolved supervisor', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'a@example.com', role: 'account_admin' },
      { email: 'b@example.com', role: 'tenant_owner' },
    ]);

    const result = await sendAgencyCampaignCompletionEmail(completion);

    expect(result).toEqual({ sent: true, recipients: 2 });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    const params = mocks.sendEmail.mock.calls.map(
      (call) => call[0] as { to: Array<{ email: string }>; subject: string; textBody: string },
    );
    expect(params.map((p) => p.to)).toEqual([
      [{ email: 'a@example.com' }],
      [{ email: 'b@example.com' }],
    ]);
    expect(params[0]!.subject).toContain('Q3 Renewals');
    expect(params[0]!.textBody).toContain(`/agency/campaigns/${CAMPAIGN}`);
  });

  /**
   * ONE recipient per send, and this is a disclosure property rather than a
   * transport preference.
   *
   * The bulk-dispatch mailer puts its whole list in one `To:`, which is fine
   * there — `notification_emails` was typed in by the tenant, so every address is
   * already known to whoever reads the mail. This audience is DERIVED from
   * `memberships`: a single `To:` would show every supervisor the account's whole
   * admin roster, addresses included, which the server has no business disclosing on
   * the strength of a campaign finishing.
   */
  it('never puts a second supervisor in the same envelope', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'a@example.com', role: 'account_admin' },
      { email: 'b@example.com', role: 'tenant_admin' },
      { email: 'c@example.com', role: 'tenant_owner' },
    ]);

    await sendAgencyCampaignCompletionEmail(completion);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    for (const call of mocks.sendEmail.mock.calls) {
      const { to } = call[0] as { to: Array<{ email: string }> };
      expect(to).toHaveLength(1);
    }
  });

  /**
   * ...and one envelope per recipient makes the ROSTER'S SIZE the burst size,
   * which is the other half of that decision and the half nothing asserted.
   *
   * `findAddressableMembersInAccount` has no `LIMIT` on purpose — a cap there
   * would silently not tell somebody entitled to be told — so an account with a
   * large admin roster used to put that many simultaneous Mailjet requests on one
   * webhook handler, sharing a process with the billing webhooks, which cannot
   * afford to have queue behind an email.
   *
   * Asserted as a PEAK rather than as a call count, because the call count is
   * identical either way: `Promise.all(recipients.map(…))` and a bounded pool both
   * send exactly N. The peak is the only observable that separates them.
   */
  it('bounds how many sends are in flight at once', async () => {
    const roster = Array.from({ length: 40 }, (_, i) => ({
      email: `supervisor-${i}@example.com`,
      role: 'account_admin',
    }));
    mocks.findAddressableMembersInAccount.mockResolvedValue(roster);

    let inFlight = 0;
    let peak = 0;
    mocks.sendEmail.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // A real timer, so every worker that CAN start has started before the first
      // send settles — an immediate resolve would let the pool run near-serially
      // and hide an unbounded implementation.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    });

    const result = await sendAgencyCampaignCompletionEmail(completion);

    // The bound, which is what the fix is. `SEND_CONCURRENCY` is 6 and is not
    // exported — 10 is asserted instead so retuning the constant within a sane
    // range does not need a test edit, while the uncapped form (peak 40) fails it.
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeLessThan(roster.length);
    // The other direction: a serial implementation also never exceeds the bound,
    // and would be a 40-round-trip webhook handler.
    expect(peak).toBeGreaterThan(1);
    // And nothing was dropped for being past the cap — the roster is not capped,
    // only the burst.
    expect(mocks.sendEmail).toHaveBeenCalledTimes(40);
    expect(result).toEqual({ sent: true, recipients: 40 });
  });

  /**
   * A partial delivery is `sent`, with the count that actually left. Calling it
   * `failed` would tell an operator nobody was notified while supervisors are
   * reading the mail; calling three-of-three's count would overstate it.
   */
  it('reports the delivered count, not the resolved count', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'a@example.com', role: 'account_admin' },
      { email: 'b@example.com', role: 'tenant_owner' },
    ]);
    mocks.sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await sendAgencyCampaignCompletionEmail(completion))
      .toEqual({ sent: true, recipients: 1 });
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  /**
   * The configured-off state of an optional subsystem, and the state of a
   * deployment with no `MAILJET_API_KEY`. It must not read the database either:
   * a no-op subsystem that still queries is a no-op with a cost.
   */
  it('is a silent no-op with no mailjet block, and reads nothing', async () => {
    setConfig({ consoleBaseUrl: 'https://app.example.com' });

    expect(await sendAgencyCampaignCompletionEmail(completion))
      .toEqual({ sent: false, reason: 'not_configured' });
    expect(mocks.findAddressableMembersInAccount).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('reports no_recipients rather than sending an empty mail', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'agent@example.com', role: 'agent' },
    ]);

    expect(await sendAgencyCampaignCompletionEmail(completion))
      .toEqual({ sent: false, reason: 'no_recipients' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  /**
   * `account_not_addressable`, and it is the outcome the LIKELY payload
   * produces rather than a corner case. The sender's `agency_campaigns.account_id` is
   * `VARCHAR(100) NOT NULL DEFAULT 'default'`, so a campaign made
   * through its own API carries `'default'` — the audience query narrows to its
   * tenant-level arm, and a tenant whose supervisors are all account-scoped
   * `account_admin`s (the ordinary multi-account shape) is told nothing at all.
   * Folded into `no_recipients` that reads as "this account has no supervisors",
   * which is a claim about the customer instead of about the payload.
   */
  it('distinguishes an unusable account_id from an account with no supervisors', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([]);

    expect(await sendAgencyCampaignCompletionEmail({ ...completion, accountId: 'default' }))
      .toEqual({ sent: false, reason: 'account_not_addressable' });
    // Logged distinctly too — the response body is the half nobody reads.
    expect(mocks.log.warn).toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.findAddressableMembersInAccount.mockResolvedValue([]);
    expect(await sendAgencyCampaignCompletionEmail(completion))
      .toEqual({ sent: false, reason: 'no_recipients' });
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  /**
   * The narrowing is worth warning about even when tenant-level admins DO exist:
   * every account-scoped supervisor was skipped, and the mail that did go out
   * looks like a complete delivery.
   */
  it('warns about an unusable account_id even when the notice still goes out', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'owner@example.com', role: 'tenant_owner' },
    ]);

    expect(await sendAgencyCampaignCompletionEmail({ ...completion, accountId: 'default' }))
      .toEqual({ sent: true, recipients: 1 });
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  /**
   * ─── UUID-SHAPED IS NOT THE SAME CLAIM AS RESOLVABLE ──────────────────────
   *
   * The hole the shape check left. A well-formed account UUID that is stale (the
   * account was deleted) or foreign (it belongs to another tenant) passed the
   * regex, so `accountUnresolvable` was false — and
   * `findAddressableMembersInAccount` then matched its `account_id IS NULL` arm
   * and handed back the TENANT-WIDE supervisors. The run reported `sent`: a
   * notice about a campaign in an account the server cannot see, delivered to an
   * audience nobody selected, filed as a clean delivery.
   *
   * `'default'` was the only unaddressable value the old check could name, and it
   * is the least interesting one — it is at least obviously wrong on sight.
   */
  it('treats a well-formed but unknown account UUID as not addressable', async () => {
    const STALE = '99999999-9999-4999-8999-999999999999';
    mocks.findByIdInTenant.mockResolvedValue(null);
    mocks.findAddressableMembersInAccount.mockResolvedValue([]);

    expect(await sendAgencyCampaignCompletionEmail({ ...completion, accountId: STALE }))
      .toEqual({ sent: false, reason: 'account_not_addressable' });
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  /**
   * And the narrowing is still worth warning about when tenant-level admins DO
   * exist — same rule the misshapen case follows, because the failure is the same
   * one: every account-scoped supervisor was skipped and the mail that went out
   * looks complete.
   */
  it('warns on an unknown account UUID even when tenant-level admins exist', async () => {
    const STALE = '99999999-9999-4999-8999-999999999999';
    mocks.findByIdInTenant.mockResolvedValue(null);
    mocks.findAddressableMembersInAccount.mockResolvedValue([
      { email: 'owner@example.com', role: 'tenant_owner' },
    ]);

    expect(await sendAgencyCampaignCompletionEmail({ ...completion, accountId: STALE }))
      .toEqual({ sent: true, recipients: 1 });
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  /**
   * Tenant-SCOPED, not a bare `findById`. A real account belonging to somebody
   * else is exactly as unaddressable here as one that does not exist, and a
   * global lookup would let a foreign id select an audience.
   */
  it('resolves the account within the tenant, not globally', async () => {
    await sendAgencyCampaignCompletionEmail(completion);
    expect(mocks.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT, TENANT);
  });

  /**
   * The shape check survives as the FIRST test, and it is not an optimisation:
   * `accounts.id` is a `uuid` column, so querying `'default'` raises `22P02`,
   * which throws, which the caller reports as `failed` — losing the very
   * distinction this whole arm exists to make.
   */
  it('refuses a misshapen account id without querying accounts at all', async () => {
    mocks.findAddressableMembersInAccount.mockResolvedValue([]);

    expect(await sendAgencyCampaignCompletionEmail({ ...completion, accountId: 'default' }))
      .toEqual({ sent: false, reason: 'account_not_addressable' });
    expect(mocks.findByIdInTenant).not.toHaveBeenCalled();
  });

  /** An absent `accountId` never reaches the lookup — there is nothing to resolve. */
  it('does not query accounts when no account was named', async () => {
    const { accountId: _dropped, ...noAccount } = completion;
    await sendAgencyCampaignCompletionEmail(noAccount);
    expect(mocks.findByIdInTenant).not.toHaveBeenCalled();
  });

  /**
   * Totality again, on the new lookup. A pool failure is a fault, not a fact
   * about the payload, so it lands on `failed` exactly as a failing audience
   * lookup does — and it must not throw out of a webhook handler that has already
   * acknowledged the campaign's terminal status.
   */
  it('reports failed instead of throwing when the account lookup throws', async () => {
    mocks.findByIdInTenant.mockRejectedValue(new Error('pool exhausted'));
    await expect(sendAgencyCampaignCompletionEmail(completion))
      .resolves.toEqual({ sent: false, reason: 'failed' });
  });

  /** An absent `accountId` is not an unusable one — it is the tenant-wide case. */
  it('does not warn when no account was named at all', async () => {
    const { accountId: _dropped, ...noAccount } = completion;
    expect(await sendAgencyCampaignCompletionEmail(noAccount))
      .toEqual({ sent: true, recipients: 1 });
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('reports failed when the transport refuses every send', async () => {
    mocks.sendEmail.mockResolvedValue(false);
    expect(await sendAgencyCampaignCompletionEmail(completion))
      .toEqual({ sent: false, reason: 'failed' });
  });

  /** Totality: the caller has already acknowledged the campaign's status. */
  it('reports failed instead of throwing when the audience lookup throws', async () => {
    mocks.findAddressableMembersInAccount.mockRejectedValue(new Error('pool exhausted'));
    await expect(sendAgencyCampaignCompletionEmail(completion))
      .resolves.toEqual({ sent: false, reason: 'failed' });
  });

  it('reports failed instead of throwing when the transport throws', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('mailjet down'));
    await expect(sendAgencyCampaignCompletionEmail(completion))
      .resolves.toEqual({ sent: false, reason: 'failed' });
  });

  /** With no `CONSOLE_BASE_URL` the notice still goes out — without the link. */
  it('sends without a link when no console origin is configured', async () => {
    setConfig({ mailjet: MAILJET });
    const result = await sendAgencyCampaignCompletionEmail(completion);
    expect(result).toEqual({ sent: true, recipients: 1 });
    const params = mocks.sendEmail.mock.calls[0]![0] as { textBody: string };
    expect(params.textBody).not.toContain('View campaign:');
  });

  /**
   * ── The delivery claim ──────────────────────────────────────────────────
   *
   * This was the one catalog event honouring its settings-page toggle while
   * having no identity at all: the toggle was real and the idempotency the
   * engine exists for was not. Webhooks are redelivered as a matter of routine
   * and `dispatchWebhook` retries a 5s timeout three times, so the duplicate is
   * near-certain the day the campaign-completion emitter lands — and the
   * cheapest moment to close it is before there is any traffic to duplicate.
   *
   * This is the claim ONLY. The per-recipient send stays (a shared `To:` would
   * disclose the account's admin roster to everyone on it), as do the
   * partial-delivery semantics. The outbox + queue consumer the module header
   * describes remains the proper fix for getting this off the webhook's critical
   * path; it is not a prerequisite for idempotency.
   */
  describe('the delivery claim', () => {
    it('claims on the CAMPAIGN, lower-cased, before sending anything', async () => {
      mocks.findAddressableMembersInAccount.mockResolvedValue([
        { email: 'Supervisor@Example.com', role: 'account_admin' },
      ]);

      await sendAgencyCampaignCompletionEmail(completion);

      expect(mocks.claim).toHaveBeenCalledWith({
        eventKey: 'agency.campaign.completed',
        tenantId: TENANT,
        accountId: ACCOUNT,
        // Every path that can report one campaign terminal resolves to this key.
        dedupeKey: `campaign:${CAMPAIGN}`,
        // An inbox is an inbox: `Alice@x.com` and `alice@x.com` are one claim.
        recipients: ['supervisor@example.com'],
      });
    });

    it('sends in the address\'s ORIGINAL spelling, not the claimed one', async () => {
      mocks.findAddressableMembersInAccount.mockResolvedValue([
        { email: 'Supervisor@Example.com', role: 'account_admin' },
      ]);

      await sendAgencyCampaignCompletionEmail(completion);

      const params = mocks.sendEmail.mock.calls[0]![0] as { to: Array<{ email: string }> };
      expect(params.to[0]!.email).toBe('Supervisor@Example.com');
    });

    it('sends NOTHING when every recipient was already claimed', async () => {
      // A webhook redelivered after it was already delivered. Not an error.
      mocks.claim.mockResolvedValue([]);

      await expect(sendAgencyCampaignCompletionEmail(completion))
        .resolves.toEqual({ sent: false, reason: 'already_notified' });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    });

    it('mails only the UNCLAIMED recipients on a partial redelivery', async () => {
      mocks.findAddressableMembersInAccount.mockResolvedValue([
        { email: 'a@example.com', role: 'account_admin' },
        { email: 'b@example.com', role: 'tenant_owner' },
      ]);
      // `a@` went out on the first delivery; only `b@` comes back.
      mocks.claim.mockResolvedValue([{ id: 'd1', recipient: 'b@example.com' }]);

      const result = await sendAgencyCampaignCompletionEmail(completion);

      expect(result).toEqual({ sent: true, recipients: 1 });
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      const params = mocks.sendEmail.mock.calls[0]![0] as { to: Array<{ email: string }> };
      expect(params.to[0]!.email).toBe('b@example.com');
    });

    it('fails CLOSED when the ledger is unwritable', async () => {
      // The opposite of `suppressUnsubscribed`, which fails open. Without the
      // claim there is no idempotency, and sending anyway is how a redelivery
      // becomes duplicate mail; a missed notice is recoverable from the campaign
      // page, a duplicate blast is not.
      mocks.claim.mockRejectedValue(new Error('pool exhausted'));

      await expect(sendAgencyCampaignCompletionEmail(completion))
        .resolves.toEqual({ sent: false, reason: 'claim_unavailable' });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    });

    it('records the outcome per recipient, because this mailer HAS one', async () => {
      mocks.findAddressableMembersInAccount.mockResolvedValue([
        { email: 'a@example.com', role: 'account_admin' },
        { email: 'b@example.com', role: 'tenant_owner' },
      ]);
      mocks.sendEmail
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await sendAgencyCampaignCompletionEmail(completion);

      expect(result).toEqual({ sent: true, recipients: 1 });
      expect(mocks.recordOutcome).toHaveBeenCalledWith('d0', 'sent', null);
      expect(mocks.recordOutcome).toHaveBeenCalledWith('d1', 'failed', expect.any(String));
    });

    it('does not claim when nobody is addressable', async () => {
      // The audience check comes first, so an empty roster spends no write.
      mocks.findAddressableMembersInAccount.mockResolvedValue([]);
      await sendAgencyCampaignCompletionEmail(completion);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it('does not claim when there is no transport configured', async () => {
      // Claiming first would burn the campaign's key while sending nothing, and
      // a burned key is never retried — configuring Mailjet afterwards would
      // then deliver nothing for that campaign, ever.
      setConfig({});
      await expect(sendAgencyCampaignCompletionEmail(completion))
        .resolves.toEqual({ sent: false, reason: 'not_configured' });
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it('never throws when recording the outcome fails', async () => {
      // The mail has already gone. A row left `pending` honestly says "claimed,
      // outcome unknown" — strictly better than failing a send that succeeded.
      mocks.recordOutcome.mockRejectedValue(new Error('gone'));
      await expect(sendAgencyCampaignCompletionEmail(completion))
        .resolves.toEqual({ sent: true, recipients: 1 });
    });

    it('keeps the claim when nothing got out at all', async () => {
      // `sendEmail` collapses timeout and error into one `false`, so a total
      // failure does not prove the message was never accepted. Matches
      // `recordCampaignNotificationOutcome`.
      mocks.sendEmail.mockResolvedValue(false);
      await expect(sendAgencyCampaignCompletionEmail(completion))
        .resolves.toEqual({ sent: false, reason: 'failed' });
      expect(mocks.recordOutcome).toHaveBeenCalledWith('d0', 'failed', expect.any(String));
    });
  });
});
