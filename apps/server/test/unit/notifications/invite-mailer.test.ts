import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The invite mailer (`src/notifications/invite-mailer.ts`).
 *
 * ── What is being pinned ───────────────────────────────────────────────────
 * Four things, and each is a decision that would otherwise be a comment:
 *
 *  1. **The link rule.** An `agent` gets the JOIN page carrying the minted token,
 *     `/agency/join/:token`; everybody else gets the plain `/login`. This
 *     replaced `/agency/login`, which removed the stray-tenant hazard only by
 *     removing the entrance: an invited agent with no Google account had nothing
 *     to click, since that page deliberately has no signup and Firebase
 *     password-reset cannot mint a credential for a user that does not exist. A
 *     drift here costs an onboarding, not a click.
 *  2. **The transport is MAILJET, and it is env-gated.** `config.mailjet` absent
 *     ⇒ `not_configured`. Deliberately NOT `platformEmail`, whose block is now a
 *     reserved seam that nothing reads — the module header carries the argument.
 *  3. **The role gate comes FIRST.** A non-`agent` role reports
 *     `not_implemented` whatever the configuration, because that role has no
 *     invite mail to send and blaming an operator's `.env` for it would send
 *     them to inspect config that is already correct.
 *  4. **Totality.** It never throws, whatever the input. The invite route awaits
 *     it inline, so a rejection here would fail an invite whose membership has
 *     already been written.
 *
 * `src/config/index.js` is mocked per case: it is the module that decides
 * whether the subsystem exists at all, and every other test in this repo that
 * cares about a config value does the same rather than mutating `process.env`
 * after load (config is frozen at import).
 *
 * `mailjet.client.js` is mocked too. The mailer reaches it through a DYNAMIC
 * `import()` — deliberately, because that module imports config statically and a
 * static import here would drag `process.exit(1)`-on-bad-config back into
 * `user.routes.ts`'s graph — and `vi.mock` intercepts a dynamic import exactly
 * as it does a static one.
 */

const TENANT = '22222222-2222-4222-8222-222222222222';
const MAILJET = { apiKey: 'k', apiSecret: 's', fromEmail: 'no-reply@test', fromName: 'Test' };
const BRAND = { name: 'Magick Agency', accent: '#7c5cfc' };

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sendEmail: vi.fn(),
  log: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('../../../src/notifications/mailjet.client.js', () => ({ sendEmail: mocks.sendEmail }));
/**
 * A STABLE logger double, not a fresh object per call.
 *
 * `createChildLogger: () => ({ … })` returns a new object every invocation, so
 * nothing outside the module can see what it logged — and the module calls it
 * once at import, so there is no way to reach that instance afterwards. That is
 * fine for tests that only care about the returned value, and useless for the
 * properties below that have no other observable: which of the two
 * `not_configured` guards refused, since both return the same discriminant.
 */
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => mocks.log,
}));

import { sendInviteEmail, inviteSignInUrl } from '../../../src/notifications/invite-mailer.js';

/** Replace the mocked config wholesale; the module reads it per call. */
function setConfig(next: Record<string, unknown>) {
  for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  Object.assign(mocks.config, next);
}

/** The ordinary configured deployment: a transport, an origin, and a brand. */
function configured(extra: Record<string, unknown> = {}) {
  setConfig({
    consoleBaseUrl: 'https://app.example.com',
    mailjet: MAILJET,
    brand: BRAND,
    ...extra,
  });
}

const TOKEN = 'tok_abcdef0123456789';

beforeEach(() => {
  setConfig({ consoleBaseUrl: 'https://app.example.com', brand: BRAND });
  mocks.sendEmail.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('inviteSignInUrl', () => {
  it('sends an agent to the JOIN page, carrying the token', async () => {
    // The token is what makes a door with a signup on it safe: the claim binds to
    // the membership the TOKEN names, so no sign-up on this path can create a
    // stray tenant or leave the real membership unclaimed.
    expect(await inviteSignInUrl('agent', TOKEN))
      .toBe(`https://app.example.com/agency/join/${TOKEN}`);
  });

  it('falls back to the agency door for an agent with NO token', async () => {
    /**
     * Not dead code. It is what a caller with no token to offer must produce,
     * and it is the strictly safer of the two wrong answers: `/agency/login` has
     * no Sign Up tab, so it cannot create a stray tenant — where a claim page
     * with nothing to claim is simply broken. It is also what the console's own copy
     * of this rule produces, which is why the two agree in every reachable
     * state.
     */
    expect(await inviteSignInUrl('agent')).toBe('https://app.example.com/agency/login');
    expect(await inviteSignInUrl('agent', null)).toBe('https://app.example.com/agency/login');
  });

  it.each(['viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    'leaves %s on the default landing, even when handed a token',
    async (role) => {
      // A supervisor is `account_admin` or above and legitimately administers in
      // `/app`; sending every one of them to the agency door would be wrong for
      // the majority of tenants, which have no dialer at all. The token is
      // ignored rather than being an error — the caller mints one per invite and
      // the ROLE is what decides whether it means anything.
      expect(await inviteSignInUrl(role, TOKEN)).toBe('https://app.example.com/login');
    },
  );

  it('percent-encodes the token into the path', async () => {
    /**
     * `base64url` emits nothing that needs encoding, which is exactly why this is
     * asserted: the mailer must not silently depend on `invite-token.ts`'s
     * alphabet. Change the encoding there and this still has to produce a
     * well-formed path rather than a link that breaks at the first `/`.
     */
    expect(await inviteSignInUrl('agent', 'a/b+c=', 'https://x.test'))
      .toBe('https://x.test/agency/join/a%2Fb%2Bc%3D');
  });

  it('no longer pins a landing path in the link', async () => {
    // This lineage replaced `?next=%2Fdialer`. The destination lives in the
    // client — the join page decides where a claimed agent goes — rather than
    // being copied into a link a server emits and cannot see change.
    expect(await inviteSignInUrl('agent', TOKEN)).not.toContain('next=');
  });

  it('returns null when no base URL is configured, rather than guessing an origin', async () => {
    // A server has no `window.location.origin` to fall back on, and a guessed host
    // in an email is a dead link sent to a real person.
    setConfig({});
    expect(await inviteSignInUrl('agent', TOKEN)).toBeNull();
  });

  it('does not double the slash on a base URL that ends in one', async () => {
    setConfig({ consoleBaseUrl: 'https://app.example.com/' });
    expect(await inviteSignInUrl('viewer')).toBe('https://app.example.com/login');
  });

  it('takes an explicit base URL over the configured one', async () => {
    expect(await inviteSignInUrl('agent', TOKEN, 'https://other.test'))
      .toBe(`https://other.test/agency/join/${TOKEN}`);
  });

  it('strips a RUN of trailing slashes, not just one', async () => {
    /**
     * The strip is `/\/+$/`, plural, and the single-slash case above cannot tell
     * it from `/\/$/`. A run is not a contrived input: `CONSOLE_BASE_URL` is set by
     * hand per environment, and a value assembled from a prefix plus a path
     * ("https://app.example.com/" + "/") is how one arrives. The consequence of
     * the singular form is a doubled path slash in an email —
     * `https://app.example.com//agency/join/…` — which some routers 404 and some
     * redirect.
     *
     * Not a protocol-relative URL: `/\/+$/` guarantees `trimmed` never ends in a
     * slash and the scheme is present either way, so `agency` is never read as a
     * hostname. A genuinely protocol-relative `//agency/...` would need
     * `trimmed === '/'`, which this regex cannot produce and which config rejects
     * outright (see the slash-only cases below).
     */
    setConfig({ consoleBaseUrl: 'https://app.example.com///' });
    expect(await inviteSignInUrl('viewer')).toBe('https://app.example.com/login');
    expect(await inviteSignInUrl('agent', TOKEN))
      .toBe(`https://app.example.com/agency/join/${TOKEN}`);
  });

  it('does not strip a slash that is not trailing', async () => {
    // The anchor matters as much as the `+`: a base URL with a path must keep it.
    // `/\/+/g` without `$` would turn this into `https:/app.example.com/tenant/login`.
    setConfig({ consoleBaseUrl: 'https://app.example.com/tenant/' });
    expect(await inviteSignInUrl('viewer')).toBe('https://app.example.com/tenant/login');
  });

  it('returns null for an explicit EMPTY base URL, rather than a relative link', async () => {
    /**
     * `baseUrl ?? config` short-circuits on nullish only, so `''` is taken as the
     * caller's answer and reaches the `if (!origin)` guard — which is a truthiness
     * check for exactly this reason, and would be wrong as `=== undefined`.
     *
     * The alternative outcome is the harmful one: `'' + '/agency/join/…'` is a
     * RELATIVE URL. In a browser that resolves against the current origin and
     * looks like it works; in an email it is not a link at all, and
     * `sendInviteEmail`'s "refuses to send an invite with no link in it" guard
     * would not fire because the value is truthy. So a malformed setting would
     * send a real person a message whose only content is a dead link.
     */
    expect(await inviteSignInUrl('agent', TOKEN, '')).toBeNull();
  });

  it.each(['/', '//', '///'])(
    'a base URL of only slashes (%s) yields a RELATIVE link — current behaviour, and a defect',
    async (origin) => {
      /**
       * ── PINNING A BUG, not endorsing one ──────────────────────────────────
       * The guard order is `if (!origin) return null;` and only THEN
       * `origin.replace(/\/+$/, '')`. So a value that is non-empty but trims to
       * empty passes the guard and produces a RELATIVE URL, which is precisely
       * the outcome the previous case explains the guard exists to prevent.
       *
       * The one-line fix is to test the TRIMMED value rather than the raw one. It
       * is deliberately not made here, because the behaviour is **unreachable in
       * production**:
       *
       *   - via config: `consoleBaseUrl` is `z.string().url().optional()`, and
       *     `''`, `'/'`, `'//'` and `'///'` are all REJECTED by that schema, so
       *     `loadConfig` refuses to boot with one.
       *   - via the parameter: `inviteSignInUrl`'s `baseUrl` override is NOT
       *     validated, and it is the only way in — but the caller
       *     (`invite-issuer.ts`) passes no override at all, so nothing in this
       *     service can reach it.
       *
       * The assertion is here rather than the fix so that changing it is a
       * decision somebody makes on purpose, with this comment in front of them,
       * rather than a silent behaviour change inside a test-only PR.
       */
      expect(await inviteSignInUrl('agent', TOKEN, origin)).toBe(`/agency/join/${TOKEN}`);
      expect(await inviteSignInUrl('viewer', TOKEN, origin)).toBe('/login');
    },
  );

  it('reads config only when no explicit base URL is given', async () => {
    /**
     * The short-circuit is a stated property of this function ("a caller that
     * already holds the origin — and every test of the URL rule itself — never
     * touches config at all"), and it is what keeps the rule testable without a
     * config module. Asserted by removing config entirely.
     */
    setConfig({});
    expect(await inviteSignInUrl('agent', TOKEN, 'https://explicit.test'))
      .toBe(`https://explicit.test/agency/join/${TOKEN}`);
  });
});

describe('sendInviteEmail', () => {
  const input = {
    email: 'newagent@example.com',
    role: 'agent' as const,
    tenantId: TENANT,
    signInUrl: `https://app.example.com/agency/join/${TOKEN}`,
    tenantName: 'Acme Collections',
    inviterName: 'Priya Sharma',
    expiresAt: new Date('2026-01-08T00:00:00Z'),
  };

  it('sends through Mailjet and reports sent: true', async () => {
    configured();

    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: true, messageId: null });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendEmail.mock.calls[0]![0];
    // One recipient, and only the invitee — never a CC of the supervisor, which
    // would disclose the invited address to somebody the invite is not for.
    expect(sent.to).toEqual([{ email: 'newagent@example.com' }]);
    expect(sent.subject).toBe("You've been added to the Magick Agency Dialer");
    // Both parts carry the link. The text part is what a plain-text client and a
    // corporate gateway show, and it is the only thing a screen reader in plain
    // mode reaches.
    expect(sent.htmlBody).toContain(input.signInUrl);
    expect(sent.textBody).toContain(input.signInUrl);
  });

  it('reports messageId: null, because Mailjet cannot say', async () => {
    /**
     * `mailjet.client.ts` returns a boolean, having already logged the
     * `MessageUUID`s it received. The field stays on the union rather than being
     * dropped because it is the natural home for the id once the send moves onto
     * `platformEmail` — where a message gets a durable row.
     */
    configured();
    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: true, messageId: null });
  });

  it('reports failed when the transport refuses', async () => {
    // `sendEmail` reports a refusal, a non-2xx and its own 10s timeout all as
    // `false`. All three are `failed`: something at the transport went wrong and
    // it is not the operator's configuration.
    configured();
    mocks.sendEmail.mockResolvedValue(false);

    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: false, reason: 'failed' });
  });

  it('reports failed on a transport TIMEOUT — and never throws it', async () => {
    /**
     * The specific regression `POST /users/invite`'s docstring anticipates. The
     * client bounds every request at `MAILJET_TIMEOUT_MS` and surfaces the abort
     * as a `false`, so the route answers 201 with `sent: false` rather than
     * sitting behind the provider for the process-wide 300s undici default and
     * then 500ing on a membership that had already been written.
     *
     * The route-level half of this property is asserted in
     * `test/unit/api/routes/user-invite-mailer-isolation.test.ts`; this is the
     * mailer's half — a rejecting transport must still resolve.
     */
    configured();
    mocks.sendEmail.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );

    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: false, reason: 'failed' });
  });

  it('reports not_configured when there is no MAILJET block', async () => {
    // The expected state of a deployment that has not provisioned mail. Explicitly
    // NOT an error: the invite still lands and the customer UI hands over the link.
    setConfig({ consoleBaseUrl: 'https://app.example.com', brand: BRAND });

    await expect(sendInviteEmail(input)).resolves.toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('ignores platformEmail entirely — it is a reserved seam, not the transport', async () => {
    /**
     * The header used to specify `PLATFORM_EMAIL_CONNECTION_ID` (a
     * Resend-backed provider) as the transport, and the schema still carries the
     * block. Setting it must change NOTHING: an operator who configures it and
     * sees invites start working would reasonably conclude it is wired up, and
     * would then be surprised when the Mailjet key is what actually expires.
     */
    setConfig({
      consoleBaseUrl: 'https://app.example.com',
      brand: BRAND,
      platformEmail: { connectionId: '11111111-1111-4111-8111-111111111111', fromName: 'X' },
    });

    await expect(sendInviteEmail(input)).resolves.toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'operator', 'account_admin', 'tenant_admin'] as const)(
    'reports not_implemented for %s, even with a fully configured transport',
    async (role) => {
      /**
       * The role gate runs BEFORE the transport gate, and this is what pins that
       * order. A non-`agent` invite has no email to send whatever the
       * configuration — there is no workspace-onboarding page to land them on —
       * so answering `not_configured` would blame an operator's `.env` for
       * something this service has simply not built.
       */
      configured();

      await expect(sendInviteEmail({ ...input, role })).resolves.toEqual({
        sent: false,
        reason: 'not_implemented',
      });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    },
  );

  it('reports not_implemented for a non-agent even with NO config at all', async () => {
    // The other half of the ordering: `not_implemented` means exactly one thing —
    // this role has no invite mail — and never doubles as "check your config".
    setConfig({});

    await expect(sendInviteEmail({ ...input, role: 'viewer' })).resolves.toEqual({
      sent: false,
      reason: 'not_implemented',
    });
  });

  it('refuses to send an invite with no link in it', async () => {
    /**
     * The email's entire job is to carry the join URL. A configured transport plus
     * no `CONSOLE_BASE_URL` would otherwise mean sending a real person a message with
     * nothing actionable in it, which is worse than sending nothing.
     *
     * Reported as `not_configured` rather than `failed`: the missing thing is a
     * setting, and `failed` would send an operator to inspect the mail provider.
     */
    configured();

    await expect(sendInviteEmail({ ...input, signInUrl: null })).resolves.toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY-STRING link too, not only a null one', async () => {
    /**
     * The guard is `if (!input.signInUrl)`, not `=== null`, and the distinction is
     * reachable: `inviteSignInUrl` returns `null`, but a caller assembling the
     * input by hand — or a future one reading a stored value — can produce `''`,
     * and `SendInviteEmailInput` types the field `string | null`, so `''` is a
     * perfectly legal value the type system will not stop.
     *
     * Under `=== null` an empty string is "a link", so the function would fall
     * through to the transport and send a real email containing no link, which is
     * the exact outcome this guard exists to prevent.
     */
    configured();

    await expect(sendInviteEmail({ ...input, signInUrl: '' })).resolves.toEqual({
      sent: false,
      reason: 'not_configured',
    });
  });

  it('never throws — a broken config resolves as failed, it does not reject', async () => {
    /**
     * The invite route awaits this inline, after the membership is written, so a
     * rejection here would report failure for an invite that succeeded — and
     * then a retry would 409 off the row the "failed" attempt created.
     *
     * The input is a config with a transport but NO `brand` block, which is what
     * the try/catch inside the send is actually for: `config.brand.name` throws a
     * `TypeError` before any transport call. Unreachable through the schema
     * (`brand` is `.default({})`, so an absent block still materialises its
     * defaults) and reachable through a hand-built config or a partial mock,
     * which is exactly the kind of thing that reaches production as a deploy with
     * one env var half-renamed.
     */
    setConfig({ consoleBaseUrl: 'https://app.example.com', mailjet: MAILJET });

    await expect(sendInviteEmail(input)).resolves.toEqual({ sent: false, reason: 'failed' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws on a nonsense expiry either — it renders and sends', async () => {
    /**
     * The other half of totality, and it is worth pinning as the CURRENT
     * behaviour rather than assumed to be a throw: `new Date('nonsense')` is a
     * valid `Date` object whose `toUTCString()` is the string "Invalid Date". So
     * the mail goes out with a small-print line nobody can act on, rather than
     * failing.
     *
     * That is the right trade for an invitation — the expiry is context, the LINK
     * is the payload, and refusing to send over a bad date would withhold an
     * agent's only route in over a cosmetic field. It is asserted so the
     * behaviour is a decision rather than a surprise, and so a future change that
     * makes it throw has to come past this case.
     */
    configured();

    await expect(
      sendInviteEmail({ ...input, expiresAt: new Date('nonsense') }),
    ).resolves.toEqual({ sent: true, messageId: null });
  });

  it('reports the missing BLOCK before the missing link when both are absent', async () => {
    /**
     * ── Why precedence is worth an assertion when both arms return the same thing ─
     * Both guards answer `{ sent: false, reason: 'not_configured' }`, so the
     * RESULT cannot distinguish them and no other case does. What differs is the
     * log, and the log is the entire operator-facing output of this function on
     * an unconfigured deployment.
     *
     * The config guard logs at DEBUG, deliberately — warning on the expected path
     * trains operators to ignore the log. The link guard logs at WARN, because a
     * configured transport with no `CONSOLE_BASE_URL` is a genuine misconfiguration
     * somebody should fix.
     *
     * Reverse the order and every unconfigured deployment emits a WARN per invite
     * about a base URL that is not the problem — the line an operator would
     * chase, pointing away from the actual state.
     */
    setConfig({ brand: BRAND });
    mocks.log.debug.mockClear();
    mocks.log.warn.mockClear();

    const result = await sendInviteEmail({ ...input, signInUrl: null });

    expect(result).toEqual({ sent: false, reason: 'not_configured' });
    expect(mocks.log.debug).toHaveBeenCalledTimes(1);
    expect(mocks.log.debug.mock.calls[0]?.[1]).toContain('no mailjet block configured');
    // The louder guard did not fire; nothing WARNs on the expected path.
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('WARNs — not debugs — when the block IS set and only the link is missing', async () => {
    // The other side of the same property: this one an operator should see.
    configured();
    mocks.log.debug.mockClear();
    mocks.log.warn.mockClear();

    await sendInviteEmail({ ...input, signInUrl: null });

    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn.mock.calls[0]?.[1]).toContain('CONSOLE_BASE_URL is unset');
    expect(mocks.log.debug).not.toHaveBeenCalled();
  });

  it('never logs the invited address, on any arm', async () => {
    /**
     * `input.email` is personal data, and none of the log calls includes it —
     * they carry `tenantId` and `role` only. Worth pinning rather than trusting,
     * because the obvious "improvement" to any of these lines is to name the
     * invitee, and the agency audit trail already establishes the rule for this
     * feature (`proxy-agency-staffing`'s "logs no PII either"). An invite is sent
     * to an address the SENDER typed, which makes a typo'd stranger's email the
     * thing that ends up in the log.
     */
    const email = 'private.person@example.com';
    for (const cfg of [{}, { mailjet: MAILJET }]) {
      for (const signInUrl of [null, `https://app.example.com/agency/join/${TOKEN}`]) {
        for (const refuse of [false, true]) {
          setConfig({ consoleBaseUrl: 'https://app.example.com', brand: BRAND, ...cfg });
          vi.clearAllMocks();
          mocks.sendEmail.mockResolvedValue(!refuse);

          await sendInviteEmail({ ...input, email, signInUrl });

          const logged = JSON.stringify([
            mocks.log.debug.mock.calls, mocks.log.warn.mock.calls,
            mocks.log.info.mock.calls, mocks.log.error.mock.calls,
          ]);
          expect(logged, `config=${JSON.stringify(cfg)} signInUrl=${signInUrl} refuse=${refuse}`)
            .not.toContain(email);
        }
      }
    }
  });

  it('sends no HTTP request of its own — the transport is the only caller', async () => {
    /**
     * The mailer must go through `mailjet.client.ts` and never `fetch` directly:
     * that client is where `MAILJET_TIMEOUT_MS` lives, and a direct `fetch` here
     * would inherit undici's process-wide 300s headers timeout — five minutes of
     * an HTTP request waiting on a mail provider, which is exactly the bound the
     * client exists to impose.
     */
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    configured();

    await sendInviteEmail(input);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
