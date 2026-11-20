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
  raiseHelp: vi.fn(),
  cancelHelp: vi.fn(),
  useTenant: vi.fn(),
  getMyStats: vi.fn(),
  getMyDay: vi.fn(),
  flags: new Set<string>(),
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
  raiseHelp: mocks.raiseHelp,
  cancelHelp: mocks.cancelHelp,
}));
vi.mock('../../api/agencyStats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyStats')>()),
  getMyStats: mocks.getMyStats,
  getMyDay: mocks.getMyDay,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Sunita Yadav', email: 's@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { STATION_COPY, breakRefusedLine } from '../../utils/agency/stationCopy';
import { FakeSocket, latestSocket as latest } from '../helpers/fakeSocket';
import { stubStationMicrophone } from '../helpers/stationDevices';
import { ApiError } from '../../api/client';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * The console station review's fixes, each through real frames on a fake socket, asserting what
 * the agent sees and what is sent: a refused break is said (both ways in), `E` `E` while a call
 * rings and on a call, `A` and Need help on Start of day, the supervisor's hold after Save, 05d's
 * ring and banners, 08's spoken subtitle, `R`, the queued break's ✕ failing or finding the break
 * started, Which break? closing for a call, and Read aloud kept off a live call.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: { Name: 'Ramesh Goud', City: 'Siddipet' },
  prior_attempts: [],
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
    { code: 'later', label: 'Call later', requires_datetime: true },
    { code: 'refused', label: 'Refused' },
  ],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [
    { code: 'tea', label: 'Tea', limit_minutes: 15 },
    { code: 'lunch', label: 'Lunch', limit_minutes: 30 },
  ],
  context_display: { hero: ['Name', 'City'] },
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
};

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone(['Jabra Evolve 20 Mono']);
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.hangupAttempt.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.setAgentBreak.mockResolvedValue({ session_id: 'sess-1', state: 'wrapup', pending_state: 'break', break_reason: 'tea' });
  mocks.submitDisposition.mockResolvedValue({ attempt_id: 'att-1', contact_id: 'c-1', disposition_code: 'refused', contact_state: 'completed', next_attempt_at: null, agent_state: 'available' });
  mocks.getMyStats.mockResolvedValue({ totals: { attempts: 0, connected: 0, talk_seconds: 0, successes: 0 }, buckets: [] });
  mocks.getMyDay.mockRejectedValue(new ApiError(404, { error: 'Not Found' }));
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mounted(bootstrap: AgencySessionBootstrap = BOOTSTRAP) {
  mocks.createAgencySession.mockResolvedValue(bootstrap);
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

const band = () => screen.getByTestId('band-title').textContent;
const key = (k: string, target: Element | Document | Window = document.body) => act(() => {
  fireEvent.keyDown(target, { key: k });
});

async function ringing(attempt: AgencyReservedAttempt = ATTEMPT) {
  await frames(
    { event: 'reserved', attempt },
    { event: 'agent_state', state: 'reserved', since: '2026-11-20T10:00:00.000Z' },
  );
}

async function onCall() {
  await ringing();
  await frames(
    { event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' },
    { event: 'agent_state', state: 'on_call', since: '2026-11-20T10:00:04.000Z' },
  );
}

async function whatHappened(wrapup?: Record<string, unknown>) {
  await onCall();
  await frames(
    { event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: true, message: 'x' },
    { event: 'agent_state', state: 'wrapup', since: '2026-11-20T10:02:00.000Z' },
  );
  if (wrapup) {
    await frames({
      event: 'wrapup',
      wrapup: { attempt_id: 'att-1', requires_disposition: true, disposition_submitted: false, auto_return: true, ...wrapup },
    });
  }
}

async function ready() {
  await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
}

describe('a refused break is said (item 1)', () => {
  it('Take break: Which break? stays open with the station’s words and the list the server re-read', async () => {
    mocks.setAgentBreak.mockRejectedValueOnce(
      new ApiError(400, { error: 'Validation failed', code: 'unknown_break_reason', message: 'Unknown break reason. Valid codes: lunch', allowed_codes: ['lunch'] }),
    );
    await mounted();
    await ready();
    fireEvent.click(screen.getByTestId('take-break'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('break-tea'));
    });
    const dialog = screen.getByRole('dialog', { name: 'Which break?' });
    expect(within(dialog).getByTestId('break-rejection').textContent).toBe('You cannot take that break now. Choose another.');
    // The list as the server allows it now: Tea is gone.
    expect(within(dialog).queryByTestId('break-tea')).toBeNull();
    expect(within(dialog).getByTestId('break-lunch')).toBeTruthy();
    // Never the server's sentence.
    expect(dialog.textContent).not.toContain('Valid codes');
  });

  it('a refusal with another code is said by its code, and Cancel takes the line away', async () => {
    mocks.setAgentBreak.mockRejectedValueOnce(new ApiError(409, { error: 'Conflict', code: 'manual_call_live', message: 'Save the outcome first.' }));
    await mounted();
    await ready();
    fireEvent.click(screen.getByTestId('take-break'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('break-tea'));
    });
    expect(screen.getByTestId('break-rejection').textContent).toBe(breakRefusedLine('manual_call_live'));
    fireEvent.click(screen.getByTestId('which-break-cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('take-break'));
    expect(screen.queryByTestId('break-rejection')).toBeNull();
  });

  it('Save & take break: a refused break saves nothing; the dialog stays, and a break that is booked then saves', async () => {
    mocks.setAgentBreak.mockRejectedValueOnce(new ApiError(503, { error: 'Service Unavailable', code: 'dial_failed', message: 'x' }));
    await mounted();
    await whatHappened();
    fireEvent.click(screen.getByTestId('outcome-refused'));
    fireEvent.click(screen.getByTestId('save-and-break'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('break-tea'));
    });
    expect(screen.getByRole('dialog', { name: 'Which break?' })).toBeTruthy();
    expect(screen.getByTestId('break-rejection').textContent).toBe('Your break did not start. Try again.');
    expect(mocks.submitDisposition).not.toHaveBeenCalled();
    expect(band()).toBe('What happened?');

    await act(async () => {
      fireEvent.click(screen.getByTestId('break-lunch'));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
    expect(mocks.setAgentBreak.mock.invocationCallOrder[1]!).toBeLessThan(mocks.submitDisposition.mock.invocationCallOrder[0]!);
  });
});

describe('E stops a call while it rings (AS11, item 2)', () => {
  it('E then E on Call coming stops the call, with no button on the screen', async () => {
    await mounted();
    await ringing();
    expect(band()).toBe('Call coming');
    expect(screen.queryByRole('button', { name: /end call|stop/i })).toBeNull();
    key('e');
    expect(mocks.hangupAttempt).not.toHaveBeenCalled();
    expect(screen.getByTestId('ringing-stop-armed').textContent).toBe('Press E again to stop this call.');
    key('e');
    await act(async () => {});
    expect(mocks.hangupAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.hangupAttempt).toHaveBeenCalledWith('att-1', 'tenant-1', 'account-1');
    // One stop per call: more presses send nothing more.
    key('e');
    key('e');
    expect(mocks.hangupAttempt).toHaveBeenCalledTimes(1);
  });

  it('one E alone, or E typed in the note, stops nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mounted();
    await ringing();
    key('e');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByTestId('ringing-stop-armed')).toBeNull();
    key('e');
    expect(mocks.hangupAttempt).not.toHaveBeenCalled();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    key('e', field);
    key('e', field);
    field.remove();
    expect(mocks.hangupAttempt).not.toHaveBeenCalled();
  });

  it('E then E on an outbound On call ends the call', async () => {
    await mounted();
    await onCall();
    expect(band()).toBe('On call');
    key('e', window);
    expect(mocks.hangupAttempt).not.toHaveBeenCalled();
    key('e', window);
    await act(async () => {});
    expect(mocks.hangupAttempt).toHaveBeenCalledWith('att-1', 'tenant-1', 'account-1');
  });
});

describe('Start of day (items 6, 7)', () => {
  it('A is Start work, and does nothing on 01b where Start work is not', async () => {
    await mounted();
    await waitFor(() => expect(screen.getByTestId('check-microphone').getAttribute('data-check')).toBe('ok'));
    key('a');
    await act(async () => {});
    expect(mocks.setAgentAvailable).toHaveBeenCalledTimes(1);
    cleanup();
    mocks.setAgentAvailable.mockClear();

    microphone.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await mounted();
    await waitFor(() => expect(band()).toBe('Microphone is blocked'));
    key('a');
    await act(async () => {});
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('Need help is on Start of day and on 01b (spec §3: every screen but 11 and 12)', async () => {
    mocks.flags = new Set(['agency_floor_assist_enabled']);
    await mounted();
    expect(band()).toBe('Namaste, Sunita');
    expect(screen.getByTestId('need-help-button')).toBeTruthy();
    cleanup();
    microphone.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await mounted();
    await waitFor(() => expect(band()).toBe('Microphone is blocked'));
    expect(screen.getByTestId('need-help-button')).toBeTruthy();
  });
});

describe('What happened?’s banners and ring (items 3, 9, 19)', () => {
  it('a supervisor’s hold is said, and still said after Save', async () => {
    await mounted();
    await whatHappened({ ends_at: null, held_reason: 'supervisor_hold', auto_return: false });
    expect(screen.getByTestId('supervisor-hold').textContent).toBe(STATION_COPY.heldBySupervisor);
    fireEvent.click(screen.getByTestId('outcome-refused'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-next'));
    });
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
    expect(band()).toBe('What happened?');
    expect(screen.getByTestId('supervisor-hold').textContent).toBe(STATION_COPY.heldBySupervisor);
  });

  it('05d: when the time runs out the ring turns red, “Time is over 0:00”, and the banner says so', async () => {
    await mounted();
    await whatHappened({ ends_at: new Date(Date.now() + 20_000).toISOString(), held_reason: null });
    expect(screen.getByTestId('time-left').textContent).toMatch(/^Time left/);
    expect(screen.queryByTestId('time-over')).toBeNull();
    // At expiry the server ends the countdown: no deadline, and the reason it is held.
    await frames({
      event: 'wrapup',
      wrapup: { attempt_id: 'att-1', ends_at: null, requires_disposition: true, disposition_submitted: false, auto_return: false, held_reason: 'disposition_required' },
    });
    const ring = screen.getByTestId('time-left');
    expect(ring.getAttribute('data-over')).toBe('true');
    expect(ring.textContent).toBe(`${STATION_COPY.timeOver}0:00`);
    expect(screen.getByTestId('time-over').textContent).toBe(STATION_COPY.timeOverBanner);
  });

  it('a call cut by the internet says so on What happened?', async () => {
    await mounted();
    await onCall();
    await frames(
      { event: 'released', attempt_id: 'att-1', reason: 'agent_disconnected', requires_disposition: true, message: 'x' },
      { event: 'agent_state', state: 'wrapup', since: '2026-11-20T10:02:00.000Z' },
    );
    expect(screen.getByTestId('call-was-cut').textContent).toBe(STATION_COPY.callWasCut);
  });
});

describe('08 Break over (item 4)', () => {
  it('speaks a static subtitle; the counting words are hidden from the band’s live region', async () => {
    await mounted();
    await frames({ event: 'agent_state', state: 'break', break_reason: 'tea', since: new Date(Date.now() - 17 * 60_000).toISOString() });
    expect(band()).toBe('Break time is over');
    const subtitle = screen.getByTestId('band-subtitle');
    const counting = within(subtitle).getByTestId('break-over-late');
    expect(counting.textContent).toMatch(/^You are \d+:\d{2} late\. Start calls now\.$/);
    expect(counting.closest('[aria-hidden="true"]')).not.toBeNull();
    // What a screen reader reads of the band: the static line, nothing that counts.
    const spoken = [...subtitle.childNodes]
      .filter((n) => !(n instanceof Element && n.closest('[aria-hidden="true"]')))
      .map((n) => n.textContent)
      .join('');
    expect(spoken).toBe(STATION_COPY.breakOverSpoken);
    expect(spoken).not.toMatch(/\d/);
  });
});

describe('the keys and the queued break (item 12)', () => {
  it('R on Internet problem tries again', async () => {
    mocks.mintStationToken.mockResolvedValue({ station_ws_url: '/proxy/agency/station/sess-1?token=t2' });
    await mounted();
    await ready();
    await act(async () => {
      latest().serverClose(1006);
    });
    expect(band()).toBe('Internet problem');
    const before = mocks.mintStationToken.mock.calls.length;
    key('r');
    await act(async () => {});
    // A fresh token for a new socket, at once: the press, not the retry ladder's timer.
    expect(mocks.mintStationToken.mock.calls.length).toBe(before + 1);
  });

  it('the queued break’s ✕ failing keeps the chip and says so', async () => {
    mocks.cancelQueuedBreak.mockRejectedValueOnce(new ApiError(500, { error: 'Internal', message: 'x' }));
    await mounted();
    await onCall();
    await frames({ event: 'agent_state', state: 'on_call', since: '2026-11-20T10:00:04.000Z', pending_state: 'break', pending_break_reason: 'tea' });
    const chip = screen.getByTestId('queued-break');
    expect(chip.textContent).toContain('Tea break after this call');
    expect(screen.getByTestId('queued-break-cancel').getAttribute('aria-label')).toBe(STATION_COPY.cancelBreakAfterCall);
    await act(async () => {
      fireEvent.click(screen.getByTestId('queued-break-cancel'));
    });
    expect(screen.getByTestId('queued-break').textContent).toContain(STATION_COPY.breakCancelFailed);
  });

  it('the ✕ finding the break already started says “Your break already started.”', async () => {
    mocks.cancelQueuedBreak.mockRejectedValueOnce(new ApiError(409, { error: 'Break Already Started', code: 'break_already_applied', message: 'x' }));
    await mounted();
    await whatHappened();
    await frames({ event: 'agent_state', state: 'wrapup', since: '2026-11-20T10:02:00.000Z', pending_state: 'break', pending_break_reason: 'tea' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queued-break-cancel'));
    });
    expect(screen.queryByTestId('queued-break')).toBeNull();
    expect(screen.getByTestId('break-already-started').textContent).toBe(STATION_COPY.breakAlreadyStarted);
  });
});

describe('Which break? and a call (item 17)', () => {
  it('a call coming closes it, so the call’s own keys work', async () => {
    await mounted();
    await ready();
    fireEvent.click(screen.getByTestId('take-break'));
    expect(screen.getByRole('dialog', { name: 'Which break?' })).toBeTruthy();
    await ringing();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(band()).toBe('Call coming');
    // D asks Don't call again on the call: the keyboard is the station's again.
    key('d');
    expect(screen.getByRole('dialog', { name: STATION_COPY.stopCallingTitle })).toBeTruthy();
  });
});

describe('Read aloud stays off a live call (item 22)', () => {
  const SCRIPTED: AgencySessionBootstrap = {
    ...BOOTSTRAP,
    script: { opening: 'Namaste {name}.', steps: [{ text: 'Ask when they can pay.' }] },
  };
  let speak: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    speak = vi.fn();
    cancel = vi.fn();
    class Utterance {
      voice: unknown = null;
      lang = '';
      rate = 1;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => [{ lang: 'en-IN', name: 'Heera' }] });
  });

  it('the opening line has its speaker before the call connects; On call’s steps have none', async () => {
    await mounted(SCRIPTED);
    await ringing();
    expect(screen.getByTestId('script-opening-say')).toBeTruthy();
    await frames({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' });
    expect(band()).toBe('On call');
    expect(screen.getByTestId('script-steps')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /aloud/i })).toBeNull();
  });

  it('what is being read stops when the screen changes', async () => {
    await mounted(SCRIPTED);
    await ringing();
    fireEvent.click(screen.getByTestId('script-opening-say'));
    expect(speak).toHaveBeenCalledTimes(1);
    cancel.mockClear();
    await frames({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' });
    expect(cancel).toHaveBeenCalled();
  });

  it('keeps the speakers on What happened?’s tiles', async () => {
    await mounted(SCRIPTED);
    await whatHappened();
    expect(screen.getByRole('button', { name: 'Read “Call later” aloud' })).toBeTruthy();
  });
});

describe('My calls today from ⋮ More (AS9, item 8)', () => {
  it('opens My calls masking this list’s numbers when the list masks them', async () => {
    await mounted({ ...BOOTSTRAP, phone_display: 'masked' });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: STATION_COPY.more }));
    expect(screen.getByTestId('station-menu-my_calls').getAttribute('href')).toBe('/dialer/attempts?masked=camp-1');
  });
});
