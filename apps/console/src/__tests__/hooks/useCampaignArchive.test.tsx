import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, act, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Archive and Restore from the campaign header (AR1–AR7): Archive asks first and Restore does not;
 * the answer is painted through the page's `commitCampaign`; a 409 re-reads the campaign and says
 * why; a second press while one is in flight sends nothing.
 */

const mocks = vi.hoisted(() => ({
  setAgencyCampaignArchived: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  track: vi.fn(),
  navigate: vi.fn(),
  getCampaignInboundDefaultRoutes: vi.fn(),
}));

vi.mock('../../api/agencyCampaigns', () => ({ setAgencyCampaignArchived: mocks.setAgencyCampaignArchived }));
vi.mock('../../api/callSettings', () => ({ getCampaignInboundDefaultRoutes: mocks.getCampaignInboundDefaultRoutes }));
vi.mock('../../analytics/events', () => ({ trackAgencyCampaignArchiveAction: mocks.track }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));

import { useCampaignArchive } from '../../pages/agency/campaign-detail/useCampaignArchive';
import { ApiError } from '../../api/client';

const ARCHIVED = { id: 'c-1', name: 'Diwali leads', status: 'draft', archived_at: '2026-11-20T06:00:00Z' };

function setup(status = 'draft') {
  const commitCampaign = vi.fn();
  const refreshCampaign = vi.fn().mockResolvedValue(null);
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
  const hook = renderHook(
    () => useCampaignArchive({ id: 'c-1', tenantId: 't-1', accountId: 'a-1', campaignStatus: status, refreshCampaign, commitCampaign }),
    { wrapper },
  );
  return { hook, commitCampaign, refreshCampaign };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCampaignInboundDefaultRoutes.mockResolvedValue([]);
});

describe('useCampaignArchive', () => {
  it('asks before archiving, says a draft will not start, then archives and paints the answer', async () => {
    mocks.setAgencyCampaignArchived.mockResolvedValue(ARCHIVED);
    const { hook, commitCampaign } = setup('draft');
    act(() => hook.result.current.onArchive());
    expect(mocks.setAgencyCampaignArchived).not.toHaveBeenCalled();
    render(<>{hook.result.current.confirmDialog}</>);
    expect(screen.getByText(/cannot be started until it is restored/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive campaign' }));
    await waitFor(() => expect(commitCampaign).toHaveBeenCalledWith(ARCHIVED));
    expect(mocks.setAgencyCampaignArchived).toHaveBeenCalledWith('c-1', 'archive', 't-1', 'a-1');
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Campaign archived. It is now under Archived campaigns.', 'success', undefined,
      expect.objectContaining({ label: 'View archived' }),
    );
    // The toast's action opens Archived campaigns.
    mocks.showToast.mock.calls[0]![3].onClick();
    expect(mocks.navigate).toHaveBeenCalledWith('/agency/campaigns/archived');
    expect(mocks.track).toHaveBeenCalledWith({ campaign_id: 'c-1', action: 'archive', status: 'draft', from: 'campaign_header' });
  });

  it('leaves the draft note out of the confirm for a stopped campaign', () => {
    const { hook } = setup('stopped');
    act(() => hook.result.current.onArchive());
    render(<>{hook.result.current.confirmDialog}</>);
    expect(screen.queryByText(/cannot be started/)).toBeNull();
  });

  it('restores without asking', async () => {
    mocks.setAgencyCampaignArchived.mockResolvedValue({ ...ARCHIVED, archived_at: null });
    const { hook, commitCampaign } = setup();
    await act(async () => hook.result.current.onRestore());
    expect(mocks.setAgencyCampaignArchived).toHaveBeenCalledWith('c-1', 'unarchive', 't-1', 'a-1');
    expect(commitCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith('Campaign restored to the Campaigns page.', 'success');
    expect(mocks.track).toHaveBeenCalledWith({ campaign_id: 'c-1', action: 'unarchive', status: 'draft', from: 'campaign_header' });
  });

  it('re-reads the campaign on a 409 and says why', async () => {
    const refusal = new ApiError(409, 'Only a draft or a stopped campaign can be archived; this one is running.');
    mocks.setAgencyCampaignArchived.mockRejectedValue(refusal);
    const { hook, commitCampaign, refreshCampaign } = setup();
    await act(async () => hook.result.current.onRestore());
    expect(refreshCampaign).toHaveBeenCalledTimes(1);
    expect(commitCampaign).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith(refusal, 'Could not restore the campaign.');
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it('sends one request for two presses in the same moment', async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.setAgencyCampaignArchived.mockReturnValue(new Promise((r) => { answer = r; }));
    const { hook } = setup();
    act(() => {
      hook.result.current.onRestore();
      hook.result.current.onRestore();
    });
    expect(mocks.setAgencyCampaignArchived).toHaveBeenCalledTimes(1);
    expect(hook.result.current.busy).toBe('unarchive');
    await act(async () => answer(ARCHIVED));
    expect(hook.result.current.busy).toBeNull();
  });
});

// docs/call-log.md §5 (CL21): archiving a campaign an inbound number files its unknown callers under asks first.
describe('archiving a campaign that receives unknown callers', () => {
  function Page() {
    const archive = useCampaignArchive({
      id: 'c-1', tenantId: 't-1', accountId: 'a-1', campaignStatus: 'stopped',
      refreshCampaign: vi.fn().mockResolvedValue(null), commitCampaign: vi.fn(),
    });
    return (
      <>
        <button type="button" onClick={archive.onArchive}>Archive</button>
        {archive.confirmDialog}
      </>
    );
  }

  it('the confirmation names the inbound numbers and says what to do first; it is read only once Archive is pressed', async () => {
    mocks.getCampaignInboundDefaultRoutes.mockResolvedValue([{ route_id: 'r-1', name: 'Sales line' }, { route_id: 'r-2', name: 'Support line' }]);
    mocks.setAgencyCampaignArchived.mockResolvedValue(ARCHIVED);
    render(<MemoryRouter><Page /></MemoryRouter>);
    expect(mocks.getCampaignInboundDefaultRoutes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(
      'This campaign receives unknown callers on Sales line and Support line. Choose another campaign for those routes first.',
    ));
    expect(mocks.getCampaignInboundDefaultRoutes).toHaveBeenCalledWith('c-1', 't-1', 'a-1');
    // It asks; it does not hold the archive back.
    fireEvent.click(screen.getByRole('button', { name: 'Archive campaign' }));
    await waitFor(() => expect(mocks.setAgencyCampaignArchived).toHaveBeenCalledWith('c-1', 'archive', 't-1', 'a-1'));
  });

  it('says nothing for a campaign no number files callers under, or when that could not be read', async () => {
    mocks.getCampaignInboundDefaultRoutes.mockRejectedValue(new Error('403'));
    render(<MemoryRouter><Page /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await act(async () => {});
    expect(screen.getByRole('dialog').textContent).not.toContain('unknown callers');
  });
});
