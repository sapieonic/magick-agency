import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationEventPreference } from '../../types/notifications';

/**
 * Notification settings — the page where somebody turns their own emails off.
 *
 * ── What this file exists to prevent ──────────────────────────────────────
 *
 * "Renders the toggles" passes against a page that never sends anything, sends
 * everything on every save, or shows a subscribed person an unchecked box. Each
 * of those is invisible until a customer either keeps getting mail they turned
 * off or stops getting mail they wanted, and both arrive as support tickets
 * rather than as errors.
 *
 *  1. **The catalog is SERVED.** Nothing about the events is written in this
 *     repo, so the page must render a category, a cadence and a label it has
 *     never heard of. A build of master with a new event has to light it up
 *     here with no frontend change — the rule the audit log's
 *     `available_actions` established.
 *  2. **A default is a SUBSCRIPTION, not an absence.** `is_default: true` with
 *     `enabled: true` means the person is genuinely subscribed. Rendering that
 *     as off would invite them to turn on something already on.
 *  3. **The save is a PATCH.** Only what changed is sent, so a client built
 *     against an older catalog cannot reset an event it has never heard of.
 *  4. **A frequency goes only where it means something.** Master REFUSES a
 *     frequency on an immediate event rather than ignoring it, so sending one
 *     would 400 the whole save over a field the person never touched.
 *  5. **An empty catalog is a finding, not a failure.** The page must say so
 *     rather than render blank. Note it is a genuinely empty catalog, NOT "a
 *     dialer `agent` has no subscriptions" as this used to claim — master shows
 *     every role the two `explicit`-audience `campaign.*` events, so an agent
 *     has real toggles to manage.
 *  6. **The modal must agree with the mail, figure for figure.** Its whole
 *     promise is "exactly what would be sent", so a caption, a rounding or an
 *     omitted row that differs from master's template breaks it quietly.
 *
 * PORT NOTE (magick-agency): property 6 goes with the digest preview it was
 * about — master's credits usage digest is not ported (plan §3.3, §3.5). DELETED:
 * `preview` (3), `the preview modal matches the mail` (6), "reports a failed
 * preview through showErrorToast" (1) and `the preview credits figure` (6
 * `it.each` rows + 1). Every other case is verbatim; the catalog fixture still
 * carries a digest-cadence event, so the cadence controls stay covered.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  /*
   * NOT aliased to `showToast`, which it used to be — and the alias is what let
   * the wrong call survive. `showErrorToast(err, fallback)` is the repo's
   * convention because it keeps a masked 5xx's request id in a copyable chip
   * and uses the longer error dwell; `showToast(err.message, 'error')` leaves
   * the id inline in the sentence. With one mock behind both names, either call
   * satisfies either assertion.
   */
  showErrorToast: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  previewDigest: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/notifications', () => ({
  getNotificationPreferences: mocks.getNotificationPreferences,
  updateNotificationPreferences: mocks.updateNotificationPreferences,
  previewDigest: mocks.previewDigest,
}));

import NotificationSettingsPage from '../../pages/settings/NotificationSettingsPage';

const TENANT = 'tenant-1';

function event(over: Partial<NotificationEventPreference> = {}): NotificationEventPreference {
  return {
    key: 'usage.digest',
    label: 'Usage digest',
    description: 'A summary of your workspace.',
    category: 'digests',
    cadence: 'digest',
    channel: 'email',
    enabled: true,
    frequency: 'weekly',
    default_enabled: true,
    default_frequency: 'weekly',
    is_default: true,
    ...over,
  };
}

const CAMPAIGN_EVENT = event({
  key: 'campaign.completed',
  label: 'Campaign finished',
  description: 'Sent when a campaign finishes.',
  category: 'campaigns',
  cadence: 'immediate',
  frequency: null,
  default_frequency: null,
  is_default: false,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <NotificationSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: TENANT });
  mocks.getNotificationPreferences.mockResolvedValue({ events: [event(), CAMPAIGN_EVENT] });
  mocks.updateNotificationPreferences.mockResolvedValue({ preferences: [] });
});

afterEach(cleanup);

describe('NotificationSettingsPage', () => {
  it('renders every served event with its own label and description', async () => {
    renderPage();
    expect(await screen.findByText('Usage digest')).toBeTruthy();
    expect(screen.getByText('Campaign finished')).toBeTruthy();
    expect(screen.getByText('A summary of your workspace.')).toBeTruthy();
  });

  it('renders a category this build has never heard of', async () => {
    // The catalog is master's. A category whitelist here would silently drop
    // every event in a grouping added after this build shipped — the events
    // would simply not appear, with nothing to say why.
    mocks.getNotificationPreferences.mockResolvedValue({
      events: [event({ key: 'billing.invoice', label: 'Invoices', category: 'billing', cadence: 'immediate', frequency: null })],
    });
    renderPage();

    expect(await screen.findByText('Invoices')).toBeTruthy();
    expect(screen.getByText('Billing')).toBeTruthy();
  });

  it('shows a default-valued subscription as ON, marked as the default', async () => {
    renderPage();
    const toggle = await screen.findByLabelText('Usage digest enabled');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('offers a cadence only on a digest', async () => {
    renderPage();
    await screen.findByText('Usage digest');
    // Two radios for the digest, and none for the immediate campaign event —
    // master 400s a frequency sent on one.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  describe('saving', () => {
    it('sends ONLY what changed', async () => {
      renderPage();
      const toggle = await screen.findByLabelText('Campaign finished enabled');
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mocks.updateNotificationPreferences).toHaveBeenCalled());
      const [, sent] = mocks.updateNotificationPreferences.mock.calls[0]!;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ event_key: 'campaign.completed', enabled: false });
    });

    it('omits the frequency on an immediate event', async () => {
      // Master REFUSES it rather than ignoring it, so including it would 400 the
      // whole save over a field the person never touched.
      renderPage();
      fireEvent.click(await screen.findByLabelText('Campaign finished enabled'));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mocks.updateNotificationPreferences).toHaveBeenCalled());
      expect(mocks.updateNotificationPreferences.mock.calls[0]![1][0]).not.toHaveProperty('frequency');
    });

    it('includes the frequency on a digest', async () => {
      renderPage();
      await screen.findByText('Usage digest');
      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mocks.updateNotificationPreferences).toHaveBeenCalled());
      expect(mocks.updateNotificationPreferences.mock.calls[0]![1][0]).toMatchObject({
        event_key: 'usage.digest', enabled: true, frequency: 'daily',
      });
    });

    it('turns the digest ON when a cadence is picked on a switched-off one', async () => {
      // Otherwise somebody picks "Every day" on a disabled digest and saves a
      // setting that changes nothing — a control that appears to work.
      mocks.getNotificationPreferences.mockResolvedValue({
        events: [event({ enabled: false, is_default: false })],
      });
      renderPage();
      await screen.findByText('Usage digest');

      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      expect((screen.getByLabelText('Usage digest enabled') as HTMLInputElement).checked).toBe(true);
    });

    it('cannot be saved with nothing changed', async () => {
      renderPage();
      await screen.findByText('Usage digest');
      expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('reports how many changes are pending', async () => {
      renderPage();
      fireEvent.click(await screen.findByLabelText('Campaign finished enabled'));
      expect(screen.getByText('1 unsaved change')).toBeTruthy();
    });

    it('surfaces a refusal rather than claiming success', async () => {
      mocks.updateNotificationPreferences.mockRejectedValue(new Error('Validation Error'));
      renderPage();
      fireEvent.click(await screen.findByLabelText('Campaign finished enabled'));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      // Through `showErrorToast(err, fallback)`, which is the repo's convention
      // and what keeps a masked 5xx's request id in a copyable chip. The error
      // is passed whole rather than flattened to `err.message`.
      await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
      const [err] = mocks.showErrorToast.mock.calls[0] as [unknown];
      expect((err as Error).message).toBe('Validation Error');
    });
  });

  describe('a tenant switch mid-load', () => {
    it('ignores a GET that resolves after the tenant moved on', async () => {
      let resolveA: ((v: unknown) => void) | undefined;
      mocks.getNotificationPreferences.mockImplementation((tenantId: string) => {
        if (tenantId === 'tenant-a') {
          return new Promise((resolve) => { resolveA = resolve; });
        }
        return Promise.resolve({
          events: [event({ key: 'campaign.completed', label: 'Tenant B event', cadence: 'immediate' })],
        });
      });

      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-a' });
      const { rerender } = renderPage();

      // Switch before A answers.
      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-b' });
      rerender(
        <MemoryRouter>
          <NotificationSettingsPage />
        </MemoryRouter>,
      );
      expect(await screen.findByText('Tenant B event')).toBeTruthy();

      // Now let A land. It must be dropped, not committed.
      resolveA?.({ events: [event({ key: 'usage.digest', label: 'Tenant A event' })] });
      await waitFor(() => expect(screen.queryByText('Tenant A event')).toBeNull());
      expect(screen.getByText('Tenant B event')).toBeTruthy();
    });

    it('does not let a stale FAILURE overwrite the current tenant with an error', async () => {
      let rejectA: ((e: unknown) => void) | undefined;
      mocks.getNotificationPreferences.mockImplementation((tenantId: string) => {
        if (tenantId === 'tenant-a') {
          return new Promise((_resolve, reject) => { rejectA = reject; });
        }
        return Promise.resolve({ events: [CAMPAIGN_EVENT] });
      });

      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-a' });
      const { rerender } = renderPage();
      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-b' });
      rerender(
        <MemoryRouter>
          <NotificationSettingsPage />
        </MemoryRouter>,
      );
      await screen.findByText('Campaign finished');

      rejectA?.(new Error('Tenant A blew up'));
      await waitFor(() => expect(screen.queryByText(/Tenant A blew up/)).toBeNull());
      expect(screen.getByText('Campaign finished')).toBeTruthy();
    });
  });

  /**
   * `showErrorToast(err, fallback)` keeps the request-id chip on a masked 5xx
   * and uses the longer dwell. Only visible now that the test mock no longer
   * aliases the two names onto one function.
   */
  describe('error reporting', () => {
    it('reports a failed save through showErrorToast', async () => {
      mocks.updateNotificationPreferences.mockRejectedValue(new Error('Request Failed'));
      renderPage();
      await screen.findByText('Usage digest');

      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
      const [err, fallback] = mocks.showErrorToast.mock.calls[0] as [unknown, string];
      expect(err).toBeInstanceOf(Error);
      expect(fallback).toMatch(/could not save/i);
    });

    it('keeps the form on screen while the post-save refetch runs', async () => {
      // A silent refetch: replacing the whole form with a spinner after a
      // successful save makes a slow follow-up GET read as a failed save.
      let resolveSecond: ((v: unknown) => void) | undefined;
      let call = 0;
      mocks.getNotificationPreferences.mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.resolve({ events: [event(), CAMPAIGN_EVENT] });
        return new Promise((resolve) => { resolveSecond = resolve; });
      });

      renderPage();
      await screen.findByText('Usage digest');
      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => expect(mocks.updateNotificationPreferences).toHaveBeenCalled());
      // Still the form, not a spinner, while the refetch is in flight.
      expect(screen.getByText('Usage digest')).toBeTruthy();
      resolveSecond?.({ events: [event(), CAMPAIGN_EVENT] });
    });
  });

  /**
   * The `Default` chip claims the value ON SCREEN came from the catalog. Keyed
   * on `is_default` alone it survived an edit, so toggling a default
   * subscription off read "Off · Default" until Save and reload.
   */
  describe('the Default chip tracks the draft', () => {
    it('shows on an untouched default', async () => {
      renderPage();
      await screen.findByText('Usage digest');
      expect(screen.getByText('Default')).toBeTruthy();
    });

    it('disappears once the cadence diverges from the default', async () => {
      renderPage();
      await screen.findByText('Usage digest');
      expect(screen.getByText('Default')).toBeTruthy();

      // Weekly is the default; picking daily diverges.
      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      await waitFor(() => expect(screen.queryByText('Default')).toBeNull());
    });

    it('comes back when the draft returns to the default value', async () => {
      renderPage();
      await screen.findByText('Usage digest');

      fireEvent.click(screen.getByRole('radio', { name: /every day/i }));
      await waitFor(() => expect(screen.queryByText('Default')).toBeNull());

      fireEvent.click(screen.getByRole('radio', { name: /every week/i }));
      await waitFor(() => expect(screen.getByText('Default')).toBeTruthy());
    });

    it('never shows on an event that HAS a stored row', async () => {
      mocks.getNotificationPreferences.mockResolvedValue({
        events: [event({ is_default: false, enabled: true, frequency: 'weekly' })],
      });
      renderPage();
      await screen.findByText('Usage digest');
      expect(screen.queryByText('Default')).toBeNull();
    });
  });

  describe('absences', () => {
    it('says there is nothing to configure rather than rendering blank', async () => {
      // A genuinely empty catalog, which is RARE — not the "a dialer agent has
      // no subscriptions" story this comment used to tell.
      // `isEventAddressableToRole` returns true for every `explicit`-audience
      // event for every role, so an `agent` sees the two `campaign.*` toggles:
      // those addresses are typed into a campaign form and may be theirs.
      mocks.getNotificationPreferences.mockResolvedValue({ events: [] });
      renderPage();
      expect(await screen.findByText(/nothing to configure/i)).toBeTruthy();
    });

    it('reports a failed load as an error, never as an empty catalog', async () => {
      // An empty page would read as "you have no notifications", which is a
      // finding about the account rather than a transport failure.
      mocks.getNotificationPreferences.mockRejectedValue(new Error('Request Failed'));
      renderPage();

      expect(await screen.findByText(/Request Failed/)).toBeTruthy();
      expect(screen.queryByText(/nothing to configure/i)).toBeNull();
    });

    it('reads nothing until a tenant is resolved', () => {
      // Preferences are per (user, tenant); a read with no tenant would either
      // 400 or answer for the wrong workspace.
      mocks.useTenant.mockReturnValue({ tenantId: undefined });
      renderPage();
      expect(mocks.getNotificationPreferences).not.toHaveBeenCalled();
    });
  });
});
