import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  AGENCY_INBOUND_CLIP_UPLOAD_LIMITS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  type AgencyInboundClipOption,
  type AgencyInboundRoute,
} from '@magick-agency/contracts/api/agency/inbound';

/**
 * The route editor's recordings (`docs/inbound.md` §8.4): an account admin uploads a recording
 * beside the clip selects, the selects offer it at once, the account's recordings are listed
 * with the routes that play each, and only one nothing uses can be deleted (the server's
 * `inbound_clip_in_use` reloads the list). Without audio storage there is no upload, and the
 * editor says callers hear our standard recordings. Every message, and every recording, can be
 * heard: Play fetches what the choice means (the recording chosen, else our standard one).
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getInboundRoute: vi.fn(),
  updateInboundRoute: vi.fn(),
  listInboundNumbers: vi.fn(),
  listInboundClips: vi.fn(),
  listAgencyCampaigns: vi.fn(),
  uploadInboundRecording: vi.fn(),
  deleteInboundRecording: vi.fn(),
  fetchRecordingBlobUrl: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: () => true }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }) }));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false }) }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    getInboundRoute: mocks.getInboundRoute,
    updateInboundRoute: mocks.updateInboundRoute,
    listInboundNumbers: mocks.listInboundNumbers,
    listInboundClips: mocks.listInboundClips,
  };
});
vi.mock('../../api/inboundRecordings', () => ({
  uploadInboundRecording: mocks.uploadInboundRecording,
  deleteInboundRecording: mocks.deleteInboundRecording,
  fetchRecordingBlobUrl: mocks.fetchRecordingBlobUrl,
}));

import InboundRouteEditorPage from '../../pages/settings/InboundRouteEditorPage';

const ROUTE: AgencyInboundRoute = {
  ...AGENCY_INBOUND_ROUTE_DEFAULTS,
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, greeting: 'clip-used' },
  weekly_hours: [{ day: 1, start: '09:00', end: '17:30' }],
  holidays: [],
  pool_campaign_ids: [],
  disposition_catalog: [],
  id: 'r-1', account_id: 'account-1', name: 'Main line', timezone: 'Europe/London',
  numbers: [],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};

const clip = (over: Partial<AgencyInboundClipOption>): AgencyInboundClipOption => ({
  id: 'clip-x', name: 'X', duration_seconds: 5, created_at: '2026-11-01T00:00:00Z', routes: [], ...over,
});
const USED = clip({ id: 'clip-used', name: 'Welcome', duration_seconds: 4.4, routes: [{ route_id: 'r-1', name: 'Main line' }] });
const SPARE = clip({ id: 'clip-spare', name: 'Old notice', duration_seconds: 75 });

async function renderEditor() {
  render(
    <MemoryRouter initialEntries={['/app/inbound/r-1']}>
      <Routes>
        <Route path="/app/inbound/:routeId" element={<InboundRouteEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const optionsOf = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.textContent);
const panel = () => within(screen.getByTestId('inbound-recordings'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'account_admin', tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.getInboundRoute.mockResolvedValue(ROUTE);
  mocks.listInboundNumbers.mockResolvedValue({ numbers: [] });
  mocks.listInboundClips.mockResolvedValue({ clips: [USED, SPARE], upload_available: true, connects_agents: true });
  mocks.listAgencyCampaigns.mockResolvedValue([]);
});

describe('the recordings', () => {
  it('lists each with its length and the routes that play it; only one nothing uses can be deleted', async () => {
    await renderEditor();
    const used = within(screen.getByTestId('inbound-recording-clip-used'));
    expect(used.getByText('Welcome')).toBeTruthy();
    expect(used.getByText('0:04 · Used by “Main line”')).toBeTruthy();
    expect((used.getByRole('button', { name: 'Delete Welcome' }) as HTMLButtonElement).disabled).toBe(true);
    const spare = within(screen.getByTestId('inbound-recording-clip-spare'));
    expect(spare.getByText('1:15 · Not used by any route')).toBeTruthy();
    expect((spare.getByRole('button', { name: 'Delete Old notice' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a recording chosen on this route but not saved yet cannot be deleted from under it', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Closed'), { target: { value: 'clip-spare' } });
    const spare = within(screen.getByTestId('inbound-recording-clip-spare'));
    expect(spare.getByText('1:15 · Chosen on this route')).toBeTruthy();
    expect((spare.getByRole('button', { name: 'Delete Old notice' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uploads one, named, and every select offers it at once', async () => {
    const uploaded = clip({ id: 'clip-new', name: 'Spring greeting', duration_seconds: 6 });
    mocks.uploadInboundRecording.mockResolvedValue({ ok: true, value: uploaded });
    await renderEditor();
    expect(optionsOf('Greeting')).not.toContain('Spring greeting');
    const file = new File(['RIFF'], 'spring.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByTestId('inbound-recording-file'), { target: { files: [file] } });
    fireEvent.change(screen.getByTestId('inbound-recording-name'), { target: { value: 'Spring greeting' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-recording-upload'));
    });
    expect(mocks.uploadInboundRecording).toHaveBeenCalledWith(file, 'Spring greeting', 'tenant-1', 'account-1');
    expect(optionsOf('Greeting')).toContain('Spring greeting');
    expect(optionsOf('We’ll call you back')).toContain('Spring greeting');
    expect(screen.getByTestId('inbound-recording-clip-new')).toBeTruthy();
    expect(screen.getByTestId('inbound-recordings-message').textContent).toBe('“Spring greeting” uploaded. Choose it for a message above.');
    // The form is cleared for the next one.
    expect((screen.getByTestId('inbound-recording-name') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('inbound-recording-upload') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why the server refused an upload, in the console’s words', async () => {
    mocks.uploadInboundRecording.mockResolvedValue({
      ok: false,
      refusal: { code: 'inbound_clip_invalid', status: 400, message: 'x', details: [], uploadReason: 'undecodable', routes: [] },
    });
    await renderEditor();
    fireEvent.change(screen.getByTestId('inbound-recording-file'), { target: { files: [new File(['junk'], 'junk.mp3')] } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-recording-upload'));
    });
    expect(screen.getByTestId('inbound-recordings-message').textContent)
      .toBe('That file couldn’t be read as audio. It may be damaged, or not the type its name says.');
    expect(screen.queryByTestId('inbound-recording-clip-new')).toBeNull();
  });

  it('refuses a file over the size limit before sending it', async () => {
    await renderEditor();
    const big = new File(['x'], 'big.wav');
    Object.defineProperty(big, 'size', { value: AGENCY_INBOUND_CLIP_UPLOAD_LIMITS.max_bytes + 1 });
    fireEvent.change(screen.getByTestId('inbound-recording-file'), { target: { files: [big] } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-recording-upload'));
    });
    expect(mocks.uploadInboundRecording).not.toHaveBeenCalled();
    expect(screen.getByTestId('inbound-recordings-message').textContent).toMatch(/too large\. Recordings can be up to 5 MB/);
  });

  it('deletes one after asking, and the selects stop offering it', async () => {
    mocks.deleteInboundRecording.mockResolvedValue({ ok: true, value: undefined });
    await renderEditor();
    expect(optionsOf('Closed')).toContain('Old notice');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old notice' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/“Old notice” will be deleted/);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    });
    expect(mocks.deleteInboundRecording).toHaveBeenCalledWith('clip-spare', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('inbound-recording-clip-spare')).toBeNull();
    expect(optionsOf('Closed')).not.toContain('Old notice');
  });

  it('a delete refused because another route took it meanwhile names the route and reloads the list', async () => {
    mocks.deleteInboundRecording.mockResolvedValue({
      ok: false,
      refusal: { code: 'inbound_clip_in_use', status: 409, message: 'x', details: [], uploadReason: null, routes: [{ route_id: 'r-2', name: 'Sales' }] },
    });
    await renderEditor();
    expect(mocks.listInboundClips).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old notice' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    });
    expect(screen.getByTestId('inbound-recordings-message').textContent).toBe('Used by “Sales”. Choose another recording there, then delete it.');
    expect(mocks.listInboundClips).toHaveBeenCalledTimes(2);
  });

  it('without audio storage there is no upload, and the editor says what callers hear instead', async () => {
    mocks.listInboundClips.mockResolvedValue({ clips: [], upload_available: false, connects_agents: true });
    await renderEditor();
    expect(screen.queryByTestId('inbound-recording-file')).toBeNull();
    expect(panel().getByTestId('inbound-recordings-unavailable').textContent).toMatch(/no audio storage set up\. Every message without one of\s+your recordings plays our standard recording/);
    expect(panel().getByText('No recordings yet. Every message plays our standard recording.')).toBeTruthy();
  });
});

describe('hearing a recording', () => {
  const play = async (testId: string) => {
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${testId}-play`));
    });
  };

  beforeEach(() => {
    mocks.fetchRecordingBlobUrl.mockImplementation(async () => ({ status: 'ready', url: 'blob:preview' }));
  });

  it('each message plays what its choice means: the recording chosen, else our standard one; the hold tone has no file', async () => {
    await renderEditor();
    // The greeting is “Welcome” (clip-used); the closed message is ours.
    expect(screen.getByRole('button', { name: 'Play the Greeting message (Welcome)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play the Closed message (our standard recording)' })).toBeTruthy();
    expect(screen.queryByTestId('inbound-clip-preview-hold-play')).toBeNull();

    await play('inbound-clip-preview-closed');
    expect(mocks.fetchRecordingBlobUrl).toHaveBeenCalledWith({ kind: 'standard', recording: 'closed' }, 'tenant-1', 'account-1');
    const player = screen.getByTestId('inbound-clip-preview-closed-audio') as HTMLAudioElement;
    expect(player.getAttribute('src')).toBe('blob:preview');
    expect(player.getAttribute('aria-label')).toBe('the Closed message (our standard recording)');

    await play('inbound-clip-preview-greeting');
    expect(mocks.fetchRecordingBlobUrl).toHaveBeenLastCalledWith({ kind: 'uploaded', clipId: 'clip-used' }, 'tenant-1', 'account-1');
  });

  it('a new choice starts from Play again, and plays the new choice', async () => {
    await renderEditor();
    await play('inbound-clip-preview-closed');
    expect(screen.getByTestId('inbound-clip-preview-closed-audio')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Closed'), { target: { value: 'clip-spare' } });
    expect(screen.queryByTestId('inbound-clip-preview-closed-audio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Play the Closed message (Old notice)' })).toBeTruthy();
    await play('inbound-clip-preview-closed');
    expect(mocks.fetchRecordingBlobUrl).toHaveBeenLastCalledWith({ kind: 'uploaded', clipId: 'clip-spare' }, 'tenant-1', 'account-1');
  });

  it('every recording in the list can be played, and one that is gone says so', async () => {
    await renderEditor();
    mocks.fetchRecordingBlobUrl.mockResolvedValueOnce({ status: 'unavailable', message: 'This recording no longer exists. Someone may have deleted it.' });
    const spare = within(screen.getByTestId('inbound-recording-clip-spare'));
    await act(async () => {
      fireEvent.click(spare.getByRole('button', { name: 'Play Old notice' }));
    });
    expect(mocks.fetchRecordingBlobUrl).toHaveBeenCalledWith({ kind: 'uploaded', clipId: 'clip-spare' }, 'tenant-1', 'account-1');
    expect(spare.getByRole('alert').textContent).toBe('This recording no longer exists. Someone may have deleted it.');
  });
});
