import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The agency workspace's sidebar — which destinations each role is offered.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * There was no sidebar test of any kind, and the component's own header makes a
 * claim about behaviour nothing verified: that an `agent` (level 5) "sees none" of
 * these entries, which is the stated reason an agent is never routed into this
 * shell at all. If that claim were false — a single entry whose floor slipped to
 * `agent` — an agent WOULD have navigation here and the routing decision built on
 * top of it would be wrong.
 *
 * Every entry is also gated on the permission of the page it opens, so a floor
 * that drifts above what the server requires hides a working page, and one that drifts
 * below offers a link that 403s on click. Both are asserted per role rather than in
 * aggregate.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn() }));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));

import { AgencySidebar } from '../../components/layout/AgencySidebar';

function renderSidebar(role: string | undefined) {
  mocks.useTenant.mockReturnValue({ role });
  return render(
    <MemoryRouter>
      <AgencySidebar />
    </MemoryRouter>,
  );
}

/**
 * The link labels currently offered, in DOM order.
 *
 * `queryAllByRole`, not `getAllByRole`: zero links is a legitimate — and asserted —
 * outcome for an `agent`, and the `get*` form throws rather than returning `[]`.
 */
function navLabels(): string[] {
  return screen
    .queryAllByRole('link')
    .map((a) => (a.textContent ?? '').trim())
    .filter(Boolean);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('AgencySidebar — what a supervisor is offered', () => {
  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    '%s gets all five destinations',
    (role) => {
      renderSidebar(role);

      expect(navLabels()).toEqual([
        'Campaigns', 'New campaign', 'Analytics', 'Do Not Call', 'Notifications',
      ]);
    },
  );

  /**
   * ── Notifications is the one entry that LEAVES this shell ───────────────
   *
   * Supervisors who live in `/agency` are the audience for
   * `agency.campaign.completed` (`agency.supervise`) and `usage.digest`
   * (`account_admin`), and they had no path to their own settings without
   * switching products: the main sidebar's entry is AppLayout-only, and so is
   * `GlobalSearch`, so Cmd+K did not help either.
   */
  it('points Notifications at the shared settings page, which lives outside /agency', () => {
    renderSidebar('account_admin');

    expect(screen.getByRole('link', { name: /notifications/i }).getAttribute('href')).toBe(
      '/app/notifications',
    );
  });

  it('points Analytics at the agency route, not the AI campaign analytics page', () => {
    // `/app/campaign-analytics` is a different feature for a different product.
    renderSidebar('account_admin');

    expect(screen.getByRole('link', { name: /analytics/i }).getAttribute('href')).toBe(
      '/agency/analytics',
    );
  });
});

describe('AgencySidebar — the floors, per role', () => {
  it('offers a viewer the read-only destinations and not the create one', () => {
    // `agency.campaigns.read` floors at `viewer`; `…write` at `account_admin`.
    // Analytics reads the campaign list plus one `/stats` each, both of which
    // the server gates on the read permission — so a viewer gets it.
    renderSidebar('viewer');

    expect(navLabels()).toEqual(['Campaigns', 'Analytics', 'Do Not Call']);
  });

  it('offers an operator the same three', () => {
    renderSidebar('operator');

    expect(navLabels()).toEqual(['Campaigns', 'Analytics', 'Do Not Call']);
  });

  /**
   * Notifications floors at `agency.supervise` here, NOT at the main sidebar's
   * `tenant.read`.
   *
   * The destination is ungated either way — anyone with a session can open it
   * and manage their own subscriptions. What this floor decides is whose shell
   * carries the link, and in THIS shell the audience for a notification setting
   * is the supervisor: the two notices that brought them here floor at
   * `agency.supervise` and `account_admin`. A viewer or operator who wants the
   * page reaches it from the main sidebar, where it floors at `tenant.read`.
   */
  it.each(['viewer', 'operator'] as const)('does not offer %s the Notifications link', (role) => {
    renderSidebar(role);

    expect(navLabels()).not.toContain('Notifications');
  });

  /**
   * The component's own claim, pinned. An `agent` holds only the four `agency.*`
   * permissions, every one of these entries floors at `viewer` or above, and that
   * is precisely why `AgencyHomeRedirect` sends an agent to `/dialer` instead of
   * into this shell — a shell whose chrome would render around nothing.
   */
  it('offers an agent NOTHING, which is why an agent is never routed here', () => {
    // Notifications does not change this: it floors at `agency.supervise`.
    // Worth stating because an `agent` DOES have real subscriptions to manage
    // (the server shows every role the two `explicit`-audience `campaign.*`
    // events) — they simply do not reach them through this shell, which they
    // never see.
    renderSidebar('agent');

    expect(navLabels()).toEqual([]);
  });

  it('offers nothing while the role is still unresolved', () => {
    // `hasPermission(undefined, …)` is false for everything, so the nav is empty
    // rather than optimistically populated and then reduced.
    renderSidebar(undefined);

    expect(navLabels()).toEqual([]);
  });
});
