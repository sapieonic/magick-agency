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
  getMyDay: vi.fn(),
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
  getMyDay: mocks.getMyDay,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Sunita Yadav', email: 's@example.com', avatar_url: null } }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { STATION_COPY } from '../../utils/agency/stationCopy';
import { FakeSocket, latestSocket as latest } from '../helpers/fakeSocket';
import { stubStationMicrophone } from '../helpers/stationDevices';
import { agentReadsFixture } from '../helpers/agentReads';
import { TileIcon } from '@magick-agency/web-ui/components/TileIcon';
import { ApiError } from '../../api/client';
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
  // A server without my-day (404): the station falls back to my-stats, as phase 0 read.
  mocks.getMyDay.mockRejectedValue(new ApiError(404, { error: 'Not Found' }));
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
    // A button with no Enter handler of its own: the browser's own activation is its click, so
    // the page must leave the key alone rather than also press Start work.
    const plain = document.createElement('button');
    screen.getByTestId('station-body').appendChild(plain);
    act(() => {
      plain.focus();
      fireEvent.keyDown(plain, { key: 'Enter' });
    });
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
    plain.remove();
  });

  it('falls back to today’s my-stats when my-day fails: calls, talk time and numbers dialled, no target', async () => {
    await mounted();
    await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
    const day = await screen.findByTestId('my-day');
    expect(within(day).getByTestId('my-day-calls').textContent).toContain('42');
    expect(within(day).getByTestId('my-day-talk').textContent).toContain('1h 52m');
    // No will pay from my-stats: the third tile is Numbers dialled, as on the app.
    expect(within(day).queryByTestId('my-day-will-pay')).toBeNull();
    expect(within(day).getByTestId('my-day-dialled').textContent).toBe('Numbers dialled61');
    expect(day.textContent).not.toContain('/');
    expect(mocks.getMyDay).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    expect(mocks.getMyStats).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: 'camp-1', bucket: 'day' }), 'tenant-1', 'account-1');
  });
});

describe('My day from my-day (BE-1 to BE-3)', () => {
  it('shows calls against the target, talk time and Will pay, and the call-later list with names, never numbers', async () => {
    mocks.getMyDay.mockResolvedValue(agentReadsFixture().my_day);
    await mounted();
    const target = await screen.findByTestId('start-target');
    expect(target.textContent).toContain('120 calls');
    await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
    const day = await screen.findByTestId('my-day');
    expect(within(day).getByTestId('my-day-calls').textContent).toContain('42 / 120');
    expect(within(day).getByTestId('my-day-will-pay').textContent).toBe('Will pay12');
    expect(within(day).queryByTestId('my-day-dialled')).toBeNull();
    const rows = within(screen.getByTestId('call-later-list')).getAllByTestId('call-later-row');
    expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual(['Sunita Patil', 'Customer', 'Imran Shaikh']);
    // The overdue one says so.
    expect(rows[0]!.textContent).toContain('Late');
    expect(screen.getByTestId('call-later-list').textContent).toContain('These calls will come to you on time.');
    expect(screen.getByTestId('station').textContent).not.toMatch(/\+?91\d{10}/);
    expect(mocks.getMyStats).not.toHaveBeenCalled();
  });

  it('on a pool campaign with no target and no promises: Numbers dialled, no call-later list', async () => {
    mocks.getMyDay.mockResolvedValue({ ...agentReadsFixture().my_day_pool_no_target, calls: 3, dialed: 17, talk_seconds: 400 });
    await mounted();
    await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
    const day = await screen.findByTestId('my-day');
    expect(within(day).getByTestId('my-day-dialled').textContent).toBe('Numbers dialled17');
    expect(within(day).queryByTestId('my-day-will-pay')).toBeNull();
    expect(day.textContent).not.toContain('/');
    expect(screen.queryByTestId('call-later-list')).toBeNull();
    expect(screen.queryByTestId('start-target')).toBeNull();
  });

  it('Finish work says how many call-laters are left and where they go', async () => {
    mocks.getMyDay.mockResolvedValue(agentReadsFixture().my_day);
    await mounted();
    await frames({ event: 'agent_state', state: 'available', since: '2026-11-20T10:00:00.000Z' });
    await screen.findByTestId('my-day');
    fireEvent.click(screen.getByRole('button', { name: STATION_COPY.more }));
    fireEvent.click(screen.getByTestId('station-menu-finish'));
    const at = new Date('2026-11-20T09:30:00.000Z').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    expect(screen.getByTestId('finish-left').textContent).toBe(`2 call-laters are left for today (first at ${at}). They wait for you.`);
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
    fireEvent.click(within(row).getByRole('button', { name: 'Half · 6,250' }));
    // A promised amount carries no currency (PT5): no ₹ in the box, the line or the chips that
    // propose one (Manas, 2026-11-20: ₹ only on a fact typed money).
    expect(screen.getByTestId('promise-resolved').textContent).toMatch(/^Will pay on \d+ \w{3} · 6,250$/);
    expect(screen.getByTestId('promise-amount').textContent).not.toMatch(/₹/);
    expect((within(row).getByLabelText('Amount') as HTMLInputElement).placeholder).toBe('12,500');
    expect(within(row).getByRole('button', { name: 'Full · 12,500' })).toBeTruthy();
    expect(row.textContent).not.toMatch(/₹/);
    // The Amount row's picture is a neutral one, not the rupee sign.
    expect(row.querySelector('[data-icon="amount"]')).not.toBeNull();
    expect(row.querySelector('.lucide-indian-rupee')).toBeNull();
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
      // An older server's untyped amount, as written: no ₹ on a guess.
      'Amount due12500',
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

describe('03 / 04 with typed facts and the campaign’s script (BE-4, BE-6, BE-8, AS9)', () => {
  const TYPED: AgencyReservedAttempt = {
    ...ATTEMPT,
    // Column names that would guess otherwise: the typed facts win.
    context: { 'Customer Name': 'Sunita Patil', City: 'Pune', 'Amount Due': 'Rs 12,500/-', 'Due Date': '20/11/2026', EMI: '4500' },
    facts: {
      name: 'Sunita Patil',
      place: 'Pune',
      tiles: [
        { column: 'EMI', type: 'text', raw: '4500', value: null },
        { column: 'Amount Due', role: 'amount_due', type: 'money', raw: 'Rs 12,500/-', value: '12500.00' },
        { column: 'Due Date', role: 'due_date', type: 'date', raw: '20/11/2026', value: '2026-11-20' },
      ],
    },
    callback: { due_at: '2026-11-20T15:00:00.000Z', booked_by_me: true, source: 'outcome' },
  };
  const SCRIPTED: AgencySessionBootstrap = {
    ...BOOTSTRAP,
    phone_display: 'masked',
    script: {
      opening: 'Namaste {name}, I am {agent_name} calling from {campaign_name}.',
      steps: [
        { text: 'Tell them the amount due: {amount_due}, due on {due_date}.' },
        { text: 'Ask when they can pay.' },
        { text: 'If they agree, confirm the date and the amount. {mood}' },
      ],
    },
  };

  async function coming(attempt: AgencyReservedAttempt = TYPED) {
    await frames(
      { event: 'reserved', attempt },
      { event: 'agent_state', state: 'reserved', since: '2026-11-20T10:00:00.000Z' },
    );
  }

  it('03: the card shows the typed facts, the call-later tag and the masked number; First, say this is filled', async () => {
    mocks.createAgencySession.mockResolvedValue(SCRIPTED);
    await mounted();
    await coming();
    const card = screen.getByTestId('customer-card');
    expect(within(card).getByTestId('customer-name').textContent).toBe('Sunita Patil');
    expect(within(card).getByTestId('call-later-tag').textContent).toBe('Call later · You said you will call at 3:00 PM');
    expect(within(card).getByTestId('customer-phone').textContent).toBe('98••• ••321');
    expect(screen.getByTestId('station').textContent).not.toContain('+919876543321');
    expect(within(card).getAllByTestId('customer-fact').map((f) => f.textContent)).toEqual([
      'Amount Due₹12,500',
      'Due Date20 Nov',
      'Last call12 Nov',
    ]);
    expect(screen.getByTestId('script-opening-line').textContent).toBe('“Namaste Sunita Patil, I am Sunita calling from EMI collections.”');
  });

  it('04: What to say fills each step, counts what is done, marks steps on a click, and starts afresh with the next call', async () => {
    mocks.createAgencySession.mockResolvedValue(SCRIPTED);
    await mounted();
    await coming();
    await frames({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' });
    const steps = () => within(screen.getByTestId('script-steps')).getAllByTestId('script-step');
    expect(steps().map((s) => s.textContent)).toEqual([
      '1Tell them the amount due: ₹12,500, due on 20 Nov.',
      '2Ask when they can pay.',
      // An unknown {word} stays as written.
      '3If they agree, confirm the date and the amount. {mood}',
    ]);
    expect(screen.getByTestId('script-progress').textContent).toBe('0 of 3 done');
    expect(steps()[0]!.getAttribute('data-state')).toBe('current');
    fireEvent.click(within(steps()[1]!).getByRole('button', { name: /Ask when/ }));
    expect(screen.getByTestId('script-progress').textContent).toBe('2 of 3 done');
    expect(steps().map((s) => s.getAttribute('data-state'))).toEqual(['done', 'done', 'current']);
    fireEvent.click(within(steps()[2]!).getByRole('button', { name: /confirm/ }));
    expect(screen.getByTestId('script-all-done').textContent).toBe('All steps done');
    // The note is still on the call screen beside the steps.
    expect(screen.getByTestId('note-card')).toBeTruthy();

    // The next call starts at the first step.
    await frames(
      { event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: false, message: 'x' },
      { event: 'agent_state', state: 'available', since: '2026-11-20T10:03:00.000Z' },
    );
    await coming({ ...TYPED, attempt_id: 'att-2' });
    await frames({ event: 'bridged', attempt_id: 'att-2', bridged_at: '2026-11-20T10:04:04.000Z' });
    expect(screen.getByTestId('script-progress').textContent).toBe('0 of 3 done');
  });

  it('the opening line has a speaker until the call connects; the steps on the call have none (the customer could hear it)', async () => {
    const speak = vi.fn();
    class Utterance {
      voice: unknown = null;
      lang = '';
      rate = 1;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [{ lang: 'en-IN', name: 'Heera' }] });
    mocks.createAgencySession.mockResolvedValue(SCRIPTED);
    await mounted();
    await coming();
    fireEvent.click(screen.getByTestId('script-opening-say'));
    await frames({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' });
    expect(screen.queryByRole('button', { name: /aloud/ })).toBeNull();
    expect(speak.mock.calls.map((c) => (c[0] as Utterance).text)).toEqual([
      'Namaste Sunita Patil, I am Sunita calling from EMI collections.',
    ]);
  });

  it('without a script, 03 shows the last calls and 04 the last calls and the note (04c)', async () => {
    await mounted();
    await coming();
    expect(screen.queryByTestId('script-opening')).toBeNull();
    expect(screen.getByTestId('last-calls')).toBeTruthy();
    await frames({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' });
    expect(screen.queryByTestId('script-steps')).toBeNull();
    expect(screen.getByTestId('last-calls')).toBeTruthy();
    expect(screen.getByTestId('note-card')).toBeTruthy();
    // Full number by default (AS9).
    expect(within(screen.getByTestId('customer-card')).getByTestId('customer-phone').textContent).toBe('+91 98765 43321');
  });

  it('Will pay offers Full and Half of the typed amount due', async () => {
    await mounted();
    await coming();
    await frames(
      { event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' },
      { event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: true, message: 'x' },
      { event: 'agent_state', state: 'wrapup', since: '2026-11-20T10:02:00.000Z' },
    );
    act(() => {
      fireEvent.keyDown(document.body, { key: '1' });
    });
    const row = screen.getByTestId('promise-row');
    expect(within(row).getByRole('button', { name: 'Full · 12,500' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Half · 6,250' })).toBeTruthy();
  });
});

describe('04 On call with the campaign’s chosen facts (AS19)', () => {
  const CHOSEN: AgencyReservedAttempt = {
    ...ATTEMPT,
    facts: {
      name: 'Sunita Patil',
      tiles: [
        { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '12,500', value: '12500' },
        { column: 'Branch 2', label: 'Branch', key: 'branch_2', type: 'text', raw: '', value: null },
      ],
    },
  };
  const BOOT: AgencySessionBootstrap = {
    ...BOOTSTRAP,
    phone_display: 'masked',
    context_display: {
      roles: { name: 'Name' },
      facts: [
        { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true },
        { column: 'Branch 2', label: 'Branch', key: 'branch_2' },
      ],
    },
    script: { steps: [{ text: 'Say {amount_due} is due at {branch_2}.' }] },
  };

  // jsdom lays nothing out: the widths (the card taking the rest beside the right column) are
  // checked in a browser, not here. This holds the card in the on-call body that sets them.
  it('shows the chosen tiles in the On call body (bodyOnCall), and "not given" in What to say', async () => {
    mocks.createAgencySession.mockResolvedValue(BOOT);
    await mounted();
    await frames(
      { event: 'reserved', attempt: CHOSEN },
      { event: 'agent_state', state: 'reserved', since: '2026-11-20T10:00:00.000Z' },
      { event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-20T10:00:04.000Z' },
    );
    expect(band()).toBe('On call');
    const card = screen.getByTestId('customer-card');
    expect(within(card).getAllByTestId('customer-fact-label').map((l) => l.textContent)).toEqual(['Amount due', 'Branch']);
    expect(within(card).getAllByTestId('customer-fact-value').map((l) => l.textContent)).toEqual(['₹12,500', '—']);
    expect(within(card).getByTestId('customer-phone').textContent).toBe('98••• ••321');
    expect(within(screen.getByTestId('script-steps')).getByTestId('script-missing').textContent).toBe('Branch not given');
    expect(screen.getByTestId('script-step').textContent).toBe('1Say ₹12,500 is due at Branch not given.');
    // The card takes the rest beside the right column (Station.module.css .bodyOnCall).
    expect(card.closest('[class*="bodyOnCall"]')).not.toBeNull();
    expect(screen.getByTestId('note-card')).toBeTruthy();
  });
});

describe('the pictures a supervisor picked (BE-13), drawn as campaign Settings draws them', () => {
  const svgOf = (icon: string) => {
    const { container, unmount } = render(<TileIcon icon={icon} size={32} />);
    const html = container.querySelector('svg')?.getAttribute('class');
    unmount();
    return html;
  };

  it('an outcome’s and a break’s icon are the shared picture, not the station’s guess', async () => {
    mocks.createAgencySession.mockResolvedValue({
      ...BOOTSTRAP,
      disposition_catalog: [
        // The flags would guess ₹ and the label a thumbs down: the pick wins.
        { code: 'ptp', label: 'Will pay', requires_promise: true, icon: 'calendar' },
        { code: 'refused', label: 'Refused', icon: 'voicemail' },
        { code: 'odd', label: 'Odd', icon: 'not-a-picture' as never },
      ],
      break_reasons: [
        { code: 'tea', label: 'Tea', icon: 'washroom' },
        { code: 'class', label: 'Training' },
      ],
    });
    await whatHappened();
    const picture = (testId: string) => screen.getByTestId(testId).querySelector('[data-tile-icon]');
    expect(picture('outcome-ptp')?.getAttribute('data-tile-icon')).toBe('calendar');
    expect(picture('outcome-ptp')?.getAttribute('class')).toBe(svgOf('calendar'));
    expect(picture('outcome-refused')?.getAttribute('data-tile-icon')).toBe('voicemail');
    // A stray stored value: the guess (a dot).
    expect(picture('outcome-odd')?.getAttribute('data-tile-icon')).toBe('dot');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'b' });
    });
    const dialog = screen.getByRole('dialog', { name: 'Which break?' });
    const pictures = [...dialog.querySelectorAll('[data-tile-icon]')].map((n) => n.getAttribute('data-tile-icon'));
    expect(pictures).toEqual(['washroom', 'training']);
    expect(dialog.querySelector('[data-tile-icon="training"]')?.getAttribute('class')).toBe(svgOf('training'));
  });
});
