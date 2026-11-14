import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The campaign workspace around Contacts, Add contacts, Call log and History, and the
 * campaign read behind it (`useAgencyCampaignDetail`, shared with the Monitor tabs).
 *
 * What is pinned here is what the sections themselves cannot see: that the header and its
 * controls are only ever the campaign the URL names (the routes have no `key`, so moving to
 * another campaign keeps all of this mounted), that a stats outage costs the strip and never
 * the campaign, that a failed campaign read is said with a Retry, and that the header is kept
 * fresh while the campaign moves.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  campaignLineage: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
// The tab bar's overdue-callbacks badge reads the allocation; never answered here, so no badge and no network.
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  campaignLineage: mocks.campaignLineage,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
}));

import { CampaignWorkspace } from '../../pages/agency/campaign-detail/CampaignWorkspace';
import {
  useAgencyCampaignDetail,
  WORKSPACE_REFRESH_MS,
} from '../../pages/agency/campaign-detail/useAgencyCampaignDetail';
import { resetCampaignTabBadges } from '../../hooks/useCampaignTabBadges';
import { noLineage, workspaceStats } from '../helpers/campaignWorkspace';

const NAMES: Record<string, string> = { 'camp-1': 'Collections', 'camp-2': 'Renewals' };

function campaign(id: string, over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return { id, name: NAMES[id] ?? id, status: 'running', ...over };
}

/** An answer held until the test lets it land. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let go: (to: string) => void = () => undefined;
function Driver() {
  go = useNavigate();
  return null;
}

/** A section that says which campaign it was handed, as the real ones name and gate on it. */
function Section() {
  const { id } = useParams<{ id: string }>();
  return (
    <CampaignWorkspace campaignId={id!} active="contacts">
      {(held) => <p data-testid="section-campaign">{held ? held.name : 'none'}</p>}
    </CampaignWorkspace>
  );
}

function renderWorkspace(id = 'camp-1') {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/${id}/contacts`]}>
      <Driver />
      <Routes>
        <Route path="/agency/campaigns/:id/contacts" element={<Section />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCampaignTabBadges();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.getAgencyCampaign.mockImplementation(async (id: string) => campaign(id));
  mocks.getAgencyCampaignStats.mockImplementation(async (id: string) => workspaceStats({ campaign_id: id }));
  mocks.campaignLineage.mockImplementation(async (id: string) => noLineage(id));
  mocks.transitionAgencyCampaign.mockImplementation(async (id: string, action: string) =>
    campaign(id, { status: action === 'stop' ? 'stopping' : 'paused' }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('campaign workspace — only ever the campaign the URL names', () => {
  it('drops the previous campaign’s header, controls and section the moment the URL moves', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { level: 1, name: 'Collections' });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

    const next = deferred<AgencyCampaign>();
    mocks.getAgencyCampaign.mockImplementation((id: string) => (id === 'camp-2' ? next.promise : Promise.resolve(campaign(id))));
    act(() => go('/agency/campaigns/camp-2/contacts'));

    // camp-2 is still being read: nothing of camp-1's may stand in for it, least of all its Stop.
    expect(screen.queryByRole('heading', { level: 1, name: 'Collections' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByTestId('section-campaign').textContent).toBe('none');

    await act(async () => next.resolve(campaign('camp-2')));
    expect(await screen.findByRole('heading', { level: 1, name: 'Renewals' })).toBeTruthy();
    expect(screen.getByTestId('section-campaign').textContent).toBe('Renewals');
  });

  it('does not carry a Stop confirmation over to the next campaign, where confirming it would stop that one', async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(screen.getByText('Stop this campaign?')).toBeTruthy();

    act(() => go('/agency/campaigns/camp-2/contacts'));
    await screen.findByRole('heading', { level: 1, name: 'Renewals' });

    expect(screen.queryByText('Stop this campaign?')).toBeNull();
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
  });

  it('paints nothing that lands for the previous campaign after the move', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { level: 1, name: 'Collections' });

    // The header's Refresh on camp-1, answered only after the move to camp-2 has painted.
    const late = deferred<AgencyCampaign>();
    mocks.getAgencyCampaign.mockImplementation((id: string) => (id === 'camp-1' ? late.promise : Promise.resolve(campaign(id))));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    act(() => go('/agency/campaigns/camp-2/contacts'));
    await screen.findByRole('heading', { level: 1, name: 'Renewals' });

    await act(async () => late.resolve(campaign('camp-1', { status: 'paused' })));
    expect(screen.getByRole('heading', { level: 1, name: 'Renewals' })).toBeTruthy();
    expect(screen.getByTestId('section-campaign').textContent).toBe('Renewals');
  });
});

describe('useAgencyCampaignDetail — another id', () => {
  it('holds nothing of the previous campaign, and is loading again, as soon as the id changes', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useAgencyCampaignDetail(id, 'tenant-1', 'account-1'),
      { initialProps: { id: 'camp-1' } },
    );
    await waitFor(() => expect(result.current.campaign?.id).toBe('camp-1'));
    expect(result.current.stats).not.toBeNull();

    mocks.getAgencyCampaign.mockImplementation(() => new Promise(() => {}));
    rerender({ id: 'camp-2' });

    expect(result.current.campaign).toBeNull();
    expect(result.current.stats).toBeNull();
    expect(result.current.lastUpdatedAt).toBeNull();
    expect(result.current.loading).toBe(true);
    // What the lifecycle controls read at click time.
    expect(result.current.campaignRef.current).toBeNull();
  });

  it('does not paint a write the server answered for the previous campaign', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useAgencyCampaignDetail(id, 'tenant-1', 'account-1'),
      { initialProps: { id: 'camp-1' } },
    );
    await waitFor(() => expect(result.current.campaign?.id).toBe('camp-1'));
    rerender({ id: 'camp-2' });
    await waitFor(() => expect(result.current.campaign?.id).toBe('camp-2'));

    act(() => result.current.commitCampaign(campaign('camp-1', { status: 'stopping' })));
    expect(result.current.campaign?.id).toBe('camp-2');
  });
});

describe('campaign workspace — the campaign does not depend on its stats', () => {
  it('still shows the header and hands the section its campaign when the stats read fails', async () => {
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('stats unavailable'));
    renderWorkspace();

    expect(await screen.findByRole('heading', { level: 1, name: 'Collections' })).toBeTruthy();
    expect(screen.getByTestId('section-campaign').textContent).toBe('Collections');
    // The header's actions with it, Add contacts among them.
    expect(screen.getByRole('link', { name: 'Add contacts' }).getAttribute('href')).toBe('/agency/campaigns/camp-1/contacts/add');
    // A list page is not blocked on the figures: no alert for them here.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a failed campaign read, with a Retry that reads it again', async () => {
    mocks.getAgencyCampaign.mockRejectedValue(new Error('Campaign service unavailable'));
    renderWorkspace();

    expect(await screen.findByText('Campaign service unavailable')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // The section is still shown, without a campaign.
    expect(screen.getByTestId('section-campaign').textContent).toBe('none');

    mocks.getAgencyCampaign.mockImplementation(async (id: string) => campaign(id));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Collections' })).toBeTruthy();
    expect(screen.queryByText('Campaign service unavailable')).toBeNull();
    expect(screen.getByTestId('section-campaign').textContent).toBe('Collections');
  });
});

describe('campaign workspace — the header and strip stay current', () => {
  it('re-reads a moving campaign every WORKSPACE_REFRESH_MS, not every 10 seconds', async () => {
    vi.useFakeTimers();
    renderWorkspace();
    await vi.waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_MS - 10_000);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(afterLoad);
  });

  it('leaves a campaign nothing is moving on alone', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockImplementation(async (id: string) => campaign(id, { status: 'paused' }));
    renderWorkspace();
    await vi.waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_MS * 2);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad);
  });
});
