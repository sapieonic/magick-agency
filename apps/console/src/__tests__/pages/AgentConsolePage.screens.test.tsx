import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  useTenant: vi.fn(),
  getMyStats: vi.fn(),
}));
vi.mock('../../api/agency', () => ({
  createAgencySession: mocks.createAgencySession,
  mintStationToken: mocks.mintStationToken,
  setAgentAvailable: mocks.setAgentAvailable,
  setAgentBreak: mocks.setAgentBreak,
  cancelQueuedBreak: mocks.cancelQueuedBreak,
  submitDisposition: mocks.submitDisposition,
  saveAttemptNotes: mocks.saveAttemptNotes,
  hangupAttempt: mocks.hangupAttempt,
}));
vi.mock('../../api/agencyStats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyStats')>()),
  getMyStats: mocks.getMyStats,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Sunita Yadav', email: 's@example.com', avatar_url: null } }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { STATION_COPY } from '../../utils/agency/stationCopy';
import { FakeSocket, latestSocket as latest } from '../helpers/fakeSocket';
import { stubStationMicrophone } from '../helpers/stationDevices';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * The redesigned station's screens that the older page tests do not reach (spec §3): Start of
 * day's checks and 01b, Enter as the main action, My day from today's my-stats, the outcome tiles
 * and their follow-up, Save before a tile is picked, Save & take break, Which break?'s limits, and
 * Read aloud. Driven through real frames on a fake socket, asserting what the agent sees.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 2,
  context: { Name: 'Ramesh Goud', City: 'Siddipet', 'Amount due': '12500', 'Due date': '2026-11-20' },
  prior_attempts: [
    { attempt_number: 1, outcome: 'connected', disposition_code: 'later', notes: 'Asked to call after salary.', ended_at: '2026-11-12T10:00:00Z', dialed_at: null, campaign_id: 'camp-1', campaign_name: 'EMI collections' },
  ],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [
    { code: 'ptp', label: 'Will pay', requires_promise: true, promise_follow_up_days: 2 },
    { code: 'later', label: 'Call later', requires_datetime: true },
    { code: 'refused', label: 'Refused', requires_note: true },
  ],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: true,
  break_reasons: [
    { code: 'tea', label: 'Tea', limit_minutes: 15 },
    { code: 'other', label: 'Other' },
  ],
  context_display: { hero: ['Name', 'City', 'Amount due', 'Due date'] },
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
};

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone(['Jabra Evolve 20 Mono']);
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.setAgentBreak.mockResolvedValue({ session_id: 'sess-1', state: 'wrapup', pending_state: 'break', break_reason: 'tea' });
  mocks.submitDisposition.mockResolvedValue({ attempt_id: 'att-1', contact_id: 'c-1', disposition_code: 'ptp', contact_state: 'completed', next_attempt_at: null, agent_state: 'available' });
  mocks.getMyStats.mockResolvedValue({ totals: { attempts: 61, connected: 42, talk_seconds: 6720, successes: 12 }, buckets: [] });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

async function frames(...list: unknown[]) {
  await act(async () => {
    for (const f of list) latest().emit(f);
  });
}

async function whatHappened() {
  await mounted();
  await frames(
    { event: 'reserved', attempt: ATTEMPT },
    { event: 'agent_state', state: 'reserved', since: '2026-11-20T10:00:00.000Z' },
    { event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' },
    { event: 'agent_state', state: 'on_call', since: '2026-11-20T10:00:04.000Z' },
  );
  await frames(
    { event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: true, message: 'x' },
    { event: 'agent_state', state: 'wrapup', since: '2026-11-20T10:02:00.000Z' },
  );
}

const band = () => screen.getByTestId('band-title').textContent;

describe('01 Start of day', () => {
  it('checks the headset, the microphone and the internet when it opens, and greets the agent by name', async () => {
    await mounted();
    expect(band()).toBe('Namaste, Sunita');
    await waitFor(() => expect(screen.getByTestId('check-microphone').getAttribute('data-check')).toBe('ok'));
    expect(screen.getByTestId('check-headset').getAttribute('data-check')).toBe('ok');
    expect(screen.getByTestId('check-internet').getAttribute('data-check')).toBe('ok');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Check these 3 things. Then start work.');
    // The probe let the microphone go at once: nothing listens between calls.
    expect(microphone.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(screen.getByTestId('todays-work').textContent).toBe('EMI collections');
  });

  it('warns in amber, without blocking, when no headset is found', async () => {
    microphone.restore();
    microphone = stubStationMicrophone(['MacBook Pro Microphone']);
    await mounted();
    await waitFor(() => expect(screen.getByTestId('check-headset').getAttribute('data-check')).toBe('warn'));
    expect(screen.getByTestId('no-headset').textContent).toBe(STATION_COPY.noHeadsetWarning);
    expect(screen.getByRole('button', { name: /start work/i })).toBeTruthy();
  });

  it('Enter starts work (the main action), and A still does', async () => {
    await mounted();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    await act(async () => {});
    expect(mocks.setAgentAvailable).toHaveBeenCalledTimes(1);
  });

  it('Enter on a focused button is that button’s, never the main action', async () => {
    await mounted();
    const more = screen.getByRole('button', { name: 'More' });
    act(() => {
      more.focus();
      fireEvent.keyDown(more, { key: 'Enter' });
    });
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('shows My day from today’s my-stats on Ready: calls and talk time, and nothing it does not have', async () => {
    await mounted();
    await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
    const day = await screen.findByTestId('my-day');
    expect(within(day).getByTestId('my-day-calls').textContent).toContain('42');
    expect(within(day).getByTestId('my-day-talk').textContent).toContain('1h 52m');
    // No target and no will-pay today (BE-1, BE-2): not shown at all.
    expect(within(day).queryByTestId('my-day-will-pay')).toBeNull();
    expect(day.textContent).not.toContain('/');
    expect(mocks.getMyStats).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: 'camp-1', bucket: 'day' }), 'tenant-1', 'account-1');
  });
});

describe('01b A check failed', () => {
  it('a blocked microphone turns the band red, hides Start work, and says what to do; Check again checks again', async () => {
    const blocked = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    microphone.getUserMedia.mockRejectedValueOnce(blocked);
    await mounted();
    await waitFor(() => expect(band()).toBe('Microphone is blocked'));
    expect(screen.getByTestId('station-band').getAttribute('data-tone')).toBe('problem');
    expect(screen.getByTestId('check-microphone').textContent).toContain('Blocked');
    expect(screen.queryByRole('button', { name: /start work/i })).toBeNull();
    expect(within(screen.getByTestId('what-to-do')).getByText('Click the lock next to the web address.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => expect(band()).toBe('Namaste, Sunita'));
    expect(microphone.getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe('05 What happened?', () => {
  it('shows one tile per outcome, in the campaign’s order, with its key, and Save faded until one is picked', async () => {
    await whatHappened();
    expect(band()).toBe('What happened?');
    const tiles = within(screen.getByTestId('outcome-tiles')).getAllByRole('button');
    expect(tiles.map((t) => t.textContent)).toEqual(['1Will pay', '2Call later', '3Refused']);
    expect(screen.getByTestId('save-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('Save before a tile is picked says “Choose one first.”, shakes the tiles, and sends nothing (spec §6.1)', async () => {
    await whatHappened();
    fireEvent.click(screen.getByTestId('save-next'));
    expect(screen.getByTestId('save-block').textContent).toBe('Choose one first.');
    expect(screen.getByTestId('outcome-tiles').getAttribute('data-shake')).toBe('true');
    expect(mocks.submitDisposition).not.toHaveBeenCalled();
    // Picking retires the line.
    fireEvent.click(screen.getByTestId('outcome-later'));
    expect(screen.queryByTestId('save-block')).toBeNull();
  });

  it('Will pay asks for the pay date, offers Full and Half of the amount due, and saves with Enter', async () => {
    await whatHappened();
    act(() => {
      fireEvent.keyDown(document.body, { key: '1' });
    });
    const row = screen.getByTestId('promise-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Half · ₹6,250' }));
    expect(screen.getByTestId('promise-resolved').textContent).toMatch(/^Will pay on \d+ \w{3} · ₹6,250$/);
    expect(screen.getByTestId('promise-follow-up').textContent).toMatch(/^We will call again on \d+ \w{3}\.$/);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    await act(async () => {});
    expect(mocks.submitDisposition).toHaveBeenCalledWith(
      'att-1',
      expect.objectContaining({ disposition_code: 'ptp', promise_amount: '6250.00' }),
      'tenant-1',
      'account-1',
    );
  });

  it('an outcome that needs a note marks the note and says so', async () => {
    await whatHappened();
    fireEvent.click(screen.getByTestId('outcome-refused'));
    expect(screen.getByTestId('note-card').getAttribute('data-needed')).toBe('true');
    expect(screen.getByTestId('note-needed').textContent).toBe('Write a note for this one.');
    fireEvent.click(screen.getByTestId('save-next'));
    expect(screen.getByTestId('save-block').textContent).toBe('Write a note for this one.');
  });

  it('Save & take break books the break first, then saves (spec 5.4)', async () => {
    await whatHappened();
    fireEvent.click(screen.getByTestId('outcome-later'));
    fireEvent.click(screen.getByRole('button', { name: 'In 1 hour' }));
    fireEvent.click(screen.getByTestId('save-and-break'));
    const dialog = screen.getByRole('dialog', { name: 'Which break?' });
    // The reason's limit is under its name; one with no limit shows no time.
    expect(within(dialog).getByTestId('break-tea').textContent).toBe('1Tea15 min');
    expect(within(dialog).getByTestId('break-other').textContent).toBe('2Other');
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('break-tea'));
    });
    expect(mocks.setAgentBreak).toHaveBeenCalledWith('sess-1', 'tea', 'tenant-1', 'account-1');
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
    expect(mocks.setAgentBreak.mock.invocationCallOrder[0]!).toBeLessThan(mocks.submitDisposition.mock.invocationCallOrder[0]!);
  });

  it('Save & take break before a tile is picked asks for one first and opens no dialog', async () => {
    await whatHappened();
    fireEvent.click(screen.getByTestId('save-and-break'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('save-block').textContent).toBe('Choose one first.');
  });
});

describe('AS13 Read aloud and Speak a note', () => {
  it('reads a tile’s label aloud in an Indian English voice when the browser has one', async () => {
    const speak = vi.fn();
    class Utterance {
      voice: unknown = null;
      lang = '';
      rate = 1;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [{ lang: 'en-US' }, { lang: 'en-IN', name: 'Heera' }] });
    await whatHappened();
    fireEvent.click(screen.getByRole('button', { name: 'Read “Call later” aloud' }));
    expect(speak).toHaveBeenCalledTimes(1);
    const said = speak.mock.calls[0]![0] as Utterance;
    expect(said.text).toBe('Call later');
    expect(said.lang).toBe('en-IN');
  });

  it('hides the speaker where the browser cannot speak, and Speak a note where it cannot listen', async () => {
    await whatHappened();
    expect(screen.queryByRole('button', { name: /aloud/ })).toBeNull();
    expect(screen.queryByTestId('speak-note')).toBeNull();
  });

  it('fills the note from the browser’s speech recognition where it has it', async () => {
    const instances: Array<{ start: () => void; onresult: ((e: unknown) => void) | null; onend: (() => void) | null }> = [];
    class Recognition {
      lang = '';
      interimResults = true;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onend?.());
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal('webkitSpeechRecognition', Recognition);
    await whatHappened();
    fireEvent.click(screen.getByTestId('speak-note'));
    expect(instances[0]!.start).toHaveBeenCalled();
    expect(screen.getByTestId('speak-note').getAttribute('aria-pressed')).toBe('true');
    act(() => {
      instances[0]!.onresult!({ results: [[{ transcript: 'Will pay on Friday' }]] });
    });
    expect((document.getElementById('agency-notes') as HTMLTextAreaElement).value).toBe('Will pay on Friday');
  });
});

describe('04 On call', () => {
  it('names the customer in the band, shows the card, the last calls and the note; End call is held, and B books a break', async () => {
    await mounted();
    await frames(
      { event: 'reserved', attempt: ATTEMPT },
      { event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' },
    );
    expect(band()).toBe('On call');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Ramesh Goud · Siddipet');
    expect(screen.getByTestId('call-recorded').textContent).toBe('Call is recorded');
    const card = screen.getByTestId('customer-card');
    expect(within(card).getByTestId('customer-name').textContent).toBe('Ramesh Goud');
    expect(within(card).getAllByTestId('customer-fact').map((f) => f.textContent)).toEqual([
      'Amount due₹12,500',
      'Due date20 Nov',
      'Last call12 Nov',
    ]);
    expect(within(screen.getByTestId('last-calls')).getByText('“Asked to call after salary.”')).toBeTruthy();
    // AS3: hold to end, the words on the button; AS2: nothing says AI.
    expect(screen.getByRole('button', { name: 'Hold to end call' })).toBeTruthy();
    expect(screen.getByTestId('station').textContent).not.toMatch(/\bAI\b/);
    // AS10: no break button on the call; B opens Which break?.
    expect(screen.queryByRole('button', { name: /break/i })).toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'b' });
    });
    expect(screen.getByRole('dialog', { name: 'Which break?' })).toBeTruthy();
  });
});
