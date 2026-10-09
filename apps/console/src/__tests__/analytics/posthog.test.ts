import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  isFeatureEnabled: vi.fn(),
  getFeatureFlag: vi.fn(),
  onFeatureFlags: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: {
    init: mocks.init,
    identify: mocks.identify,
    group: mocks.group,
    reset: mocks.reset,
    capture: mocks.capture,
    register: mocks.register,
    unregister: mocks.unregister,
    isFeatureEnabled: mocks.isFeatureEnabled,
    getFeatureFlag: mocks.getFeatureFlag,
    onFeatureFlags: mocks.onFeatureFlags,
  },
}));

/**
 * The wrapper holds module-level `enabled` state, so each scenario resets the
 * module registry and stubs the relevant env var before re-importing.
 */
async function loadModule(key?: string) {
  vi.resetModules();
  if (key !== undefined) {
    vi.stubEnv('VITE_POSTHOG_KEY', key);
  } else {
    vi.stubEnv('VITE_POSTHOG_KEY', '');
  }
  return import('../../analytics/posthog');
}

describe('analytics/posthog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('is a no-op when no key is configured', async () => {
    const a = await loadModule('');
    a.initAnalytics();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(a.isEnabled()).toBe(false);

    // Emitters stay silent without init.
    a.identifyUser({ userId: 'u1', tenantId: 't1', accountId: 'a1' });
    a.resetAnalytics();
    a.captureError('api_error', { status: 500, path: '/x' });
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('initializes with the key and registers the environment super-property', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init.mock.calls[0]![0]).toBe('phc_test');
    expect(mocks.init.mock.calls[0]![1]).toMatchObject({
      person_profiles: 'identified_only',
      disable_session_recording: true,
      rageclick: true,
      capture_dead_clicks: true,
    });
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({ environment: expect.any(String) }),
    );
    expect(a.isEnabled()).toBe(true);
  });

  it('identify maps userId and associates tenant/account groups', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.identifyUser({
      userId: 'user-1',
      email: 'x@example.com',
      displayName: 'X',
      tenantId: 'tenant-1',
      accountId: 'account-1',
    });
    expect(mocks.identify).toHaveBeenCalledWith('user-1', {
      email: 'x@example.com',
      display_name: 'X',
    });
    expect(mocks.group).toHaveBeenCalledWith('tenant', 'tenant-1');
    expect(mocks.group).toHaveBeenCalledWith('account', 'account-1');
  });

  it('identify omits groups when ids are absent', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.identifyUser({ userId: 'user-1' });
    expect(mocks.identify).toHaveBeenCalledWith('user-1', {});
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it('identify sets the role person-property and group properties when provided', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.identifyUser({
      userId: 'user-1',
      role: 'tenant_admin',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      tenant: { name: 'Acme', slug: 'acme', status: 'active', created_at: '2024-01-01' },
      account: { name: 'Main', slug: 'main', status: 'active', created_at: '2024-02-01' },
    });
    expect(mocks.identify).toHaveBeenCalledWith('user-1', { role: 'tenant_admin' });
    expect(mocks.group).toHaveBeenCalledWith('tenant', 'tenant-1', {
      name: 'Acme',
      slug: 'acme',
      status: 'active',
      created_at: '2024-01-01',
    });
    expect(mocks.group).toHaveBeenCalledWith('account', 'account-1', {
      name: 'Main',
      slug: 'main',
      status: 'active',
      created_at: '2024-02-01',
    });
    // Org id + name mirrored onto super properties for readable event context.
    expect(mocks.register).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      tenant_name: 'Acme',
      account_id: 'account-1',
      account_name: 'Main',
    });
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it('identify unregisters absent account super properties to avoid stale org context', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.identifyUser({
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: { name: 'Acme' },
    });
    expect(mocks.register).toHaveBeenCalledWith({ tenant_id: 'tenant-1', tenant_name: 'Acme' });
    expect(mocks.unregister).toHaveBeenCalledWith('account_id');
    expect(mocks.unregister).toHaveBeenCalledWith('account_name');
  });

  it('feature flags read through posthog and default off when disabled', async () => {
    const off = await loadModule('');
    off.initAnalytics();
    expect(off.isFeatureEnabled('new-ui')).toBe(false);
    expect(off.getFeatureFlag('new-ui')).toBeUndefined();
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
    // onFeatureFlags returns a no-op unsubscribe when disabled.
    expect(typeof off.onFeatureFlags(() => {})).toBe('function');
    expect(mocks.onFeatureFlags).not.toHaveBeenCalled();
  });

  it('feature flags delegate to posthog when enabled', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    mocks.isFeatureEnabled.mockReturnValue(true);
    mocks.getFeatureFlag.mockReturnValue('variant-b');
    const unsub = vi.fn();
    mocks.onFeatureFlags.mockReturnValue(unsub);

    expect(a.isFeatureEnabled('new-ui')).toBe(true);
    expect(a.getFeatureFlag('new-ui')).toBe('variant-b');

    const cb = vi.fn();
    expect(a.onFeatureFlags(cb)).toBe(unsub);
    expect(mocks.onFeatureFlags).toHaveBeenCalledWith(cb);
  });

  it('isFeatureEnabled coerces an unresolved (undefined) flag to false', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    mocks.isFeatureEnabled.mockReturnValue(undefined);
    expect(a.isFeatureEnabled('unresolved')).toBe(false);
  });

  it('reset calls posthog.reset', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.resetAnalytics();
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it('captureError forwards PII-free props', async () => {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    a.captureError('api_error', { status: 404, path: '/api/v1/calls' });
    expect(mocks.capture).toHaveBeenCalledWith('api_error', {
      status: 404,
      path: '/api/v1/calls',
    });
  });
});

/**
 * The invite token must not leave the browser, on ANY event.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `/agency/join/:token` is the only route in the app whose URL parameter is a
 * secret: the server's claim endpoint reads the TOKEN rather than the address, so for
 * the seven days it lives, whoever holds it is the invitee. posthog-js attaches
 * `$current_url`, `$pathname` and `$host` to every capture, so the token rode in
 * the envelope of the `$pageview`, of every autocapture click, rage click and
 * dead click, and of all five `agency_invite_*` events — `agency_invite_viewed`
 * included, which fires while the invitation is still PENDING and therefore still
 * worth stealing. Anybody with PostHog read access could filter for pending
 * invites, lift the URL, and claim a customer's agent membership.
 *
 * These tests are on `before_send` rather than on any emitter deliberately: an
 * emitter test would pin the five events this repo writes and say nothing about
 * the autocapture click that carries the same URL. The hook is the only place the
 * property holds for every capture.
 */
describe('analytics/posthog — the invite token never leaves the browser', () => {
  const TOKEN = 'Xk8sQ2vLp7NmR4tYwZ1aB3cD5eF6gH9jK0lM2nO4pQ6';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  /** The hook posthog-js was initialised with. */
  async function beforeSend() {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    const options = mocks.init.mock.calls[0]![1] as {
      before_send?: (cr: unknown) => unknown;
    };
    expect(typeof options.before_send).toBe('function');
    return options.before_send!;
  }

  it('redacts the token out of the URL properties posthog-js adds itself', async () => {
    const send = await beforeSend();

    const out = send({
      uuid: 'e1',
      event: '$pageview',
      properties: {
        $current_url: `https://app.example.com/agency/join/${TOKEN}?utm=mail`,
        $pathname: `/agency/join/${TOKEN}`,
        $host: 'app.example.com',
      },
    }) as { properties: Record<string, string> };

    expect(out.properties.$current_url).toBe(
      'https://app.example.com/agency/join/:token?utm=mail',
    );
    expect(out.properties.$pathname).toBe('/agency/join/:token');
    // The rest of the envelope is untouched — this redacts, it does not blank.
    expect(out.properties.$host).toBe('app.example.com');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('redacts an autocapture click, which no event catalog could have covered', async () => {
    /*
      `$elements` is an array of objects one level down, and `$el_text` is read
      off the DOM. A top-level-only pass would leave the token there.

      Set on the TEAM page rather than on the join page, which is where this
      element text actually comes from: a supervisor's copyable invitation link,
      rendered in the hand-off panel after they invite somebody. The join page's
      own captures no longer carry an element payload at all (the card opts out of
      autocapture, and `before_send` strips what is left — see the suite below),
      so asserting nested redaction there would be asserting it against a property
      that is removed for an unrelated reason.
    */
    const send = await beforeSend();

    const out = send({
      uuid: 'e2',
      event: '$autocapture',
      properties: {
        $event_type: 'click',
        $current_url: 'https://app.example.com/team',
        $elements: [
          { tag_name: 'span', $el_text: `https://app.example.com/agency/join/${TOKEN}` },
          { tag_name: 'button', $el_text: 'Copy invitation link' },
        ],
      },
    });

    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain('Copy invitation link');
    // Redacted to the route, not blanked: the link is still recognisable as one.
    expect(JSON.stringify(out)).toContain('/agency/join/:token');
  });

  it('redacts person properties too, which would otherwise pin it to a profile', async () => {
    const send = await beforeSend();

    const out = send({
      uuid: 'e3',
      event: '$identify',
      properties: { $current_url: `/agency/join/${TOKEN}` },
      $set_once: { $initial_current_url: `https://app.example.com/agency/join/${TOKEN}` },
    });

    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('redacts the two API paths as well, which reach analytics through captureApiError', async () => {
    const send = await beforeSend();

    const out = send({
      uuid: 'e4',
      event: 'api_error',
      properties: {
        status: 500,
        path: `/invites/${TOKEN}/claim`,
        other: `/invites/${TOKEN}`,
        // A literal segment, not a token: it must stay distinguishable.
        resend: '/invites/resend',
      },
    }) as { properties: Record<string, string> };

    expect(out.properties.path).toBe('/invites/:token/claim');
    expect(out.properties.other).toBe('/invites/:token');
    expect(out.properties.resend).toBe('/invites/resend');
  });

  it('leaves an ordinary event alone', async () => {
    const send = await beforeSend();
    const properties = { $current_url: 'https://app.example.com/app/calls', count: 3 };

    const out = send({ uuid: 'e5', event: 'call_placed', properties }) as {
      properties: Record<string, unknown>;
    };

    expect(out.properties).toEqual(properties);
  });

  it('drops an event it cannot clean rather than sending it', async () => {
    /*
      Fails CLOSED. The redactor is pure string work and has no way to throw that
      is not a bug in it, but the direction of that bug matters: losing an event
      is recoverable, and publishing a live invite token to everybody with PostHog
      read access is not.
    */
    const send = await beforeSend();
    const hostile = { get $current_url(): string { throw new Error('nope'); } };

    expect(send({ uuid: 'e6', event: '$pageview', properties: hostile })).toBeNull();
  });

  it('passes a null capture through, as posthog-js may hand one over', async () => {
    const send = await beforeSend();
    expect(send(null)).toBeNull();
  });
});

/**
 * The OTHER thing on the invite page, which the token redaction was never going
 * to catch: the people named on it.
 *
 * `/agency/join/:token` renders the invitee's address, the inviter's name and the
 * workspace's name, and `initAnalytics` turns on autocapture, rage clicks and
 * dead clicks — so posthog-js reads the clicked element's own text off the DOM,
 * for a click that changes nothing as readily as for one that does. None of that
 * is token-shaped, so `before_send`'s redaction passed it straight through.
 *
 * The page's `ph-no-capture` card is the primary fix and stops the event being
 * built at all; this is the second line, on the boundary, where it can be
 * asserted rather than assumed. See `analytics/redact.ts`.
 */
describe('analytics/posthog — the invite page carries no element text out', () => {
  const TOKEN = 'Xk8sQ2vLp7NmR4tYwZ1aB3cD5eF6gH9jK0lM2nO4pQ6';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  async function beforeSend() {
    const a = await loadModule('phc_test');
    a.initAnalytics();
    const options = mocks.init.mock.calls[0]![1] as { before_send?: (cr: unknown) => unknown };
    return options.before_send!;
  }

  /** An autocapture click, in the shape posthog-js builds one. */
  function click(pathname: string, text: string) {
    return {
      uuid: 'e1',
      event: '$autocapture',
      properties: {
        $event_type: 'click',
        $pathname: pathname,
        $current_url: `https://app.example.com${pathname}`,
        $elements: [{ tag_name: 'p', $el_text: text, attr__class: 'address' }],
        $elements_chain: `p.address:text="${text}"`,
      },
    };
  }

  it('strips the element payload from a click on the invite page', async () => {
    const send = await beforeSend();

    const out = send(click(`/agency/join/${TOKEN}`, 'priya@acme.com')) as {
      properties: Record<string, unknown>;
    };

    expect(JSON.stringify(out)).not.toContain('priya@acme.com');
    expect(out.properties.$elements).toBeUndefined();
    expect(out.properties.$elements_chain).toBeUndefined();
    // The event itself survives — it is the funnel, and it names nobody.
    expect(out.properties.$event_type).toBe('click');
    expect(out.properties.$pathname).toBe('/agency/join/:token');
  });

  it('strips a dead click too, which is most of the clicks on a page of text', async () => {
    const send = await beforeSend();
    const dead = click(`/agency/join/${TOKEN}`, 'Priya Sharma');
    dead.event = '$dead_click';

    expect(JSON.stringify(send(dead))).not.toContain('Priya Sharma');
  });

  it('leaves every other page’s autocapture exactly as it was', async () => {
    /*
      The rule is about one route, and it has to stay that way: element text is
      how a click is attributed anywhere else in the product, and a blanket strip
      would quietly empty every interaction funnel in the app.
    */
    const send = await beforeSend();
    const elsewhere = click('/agency/campaigns', 'Start campaign');

    const out = send(elsewhere) as { properties: Record<string, unknown> };

    expect(out.properties.$elements).toEqual([
      { tag_name: 'p', $el_text: 'Start campaign', attr__class: 'address' },
    ]);
    expect(out.properties.$elements_chain).toBe('p.address:text="Start campaign"');
  });

  it('recognises the page from the URL when there is no $pathname', async () => {
    // Not every capture carries one; the full URL always does.
    const send = await beforeSend();
    const capture = click(`/agency/join/${TOKEN}`, 'Acme Collections') as {
      properties: Record<string, unknown>;
    };
    delete capture.properties.$pathname;

    expect(JSON.stringify(send(capture))).not.toContain('Acme Collections');
  });
});
