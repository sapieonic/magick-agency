import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AgencyFloorAgent, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type { AgencyLateCallbacksPreview } from '@magick-agency/contracts/api/agency/assignment';
import { ApiError } from '../../api/client';
import { ASSIGNMENT_REFUSAL_COPY } from '../../utils/agencyAssignmentCopy';
import { board, floorRow, onBoard, stats } from '../helpers/home';

/**
 * Live floor, Phase 3 (LF4–LF7, LF28–LF33): Need help's row, red card, chip and chime; Talk to agent
 * and Send reminder through the message dialog, and each refusal; Give late callbacks to free agents,
 * previewed then committed, never on `pool`, a stale preview confirmed again; all of it behind its
 * flag.
 */

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(),
  getAgencyHomeBoard: vi.fn(),
  getAgencyGroupedStats: vi.fn(),
  getAgencyFloor: vi.fn(),
  getAgencyPromisesSummary: vi.fn(),
  getAgencyCampaign: vi.fn(),
  sendSupervisorMessage: vi.fn(),
  previewLateCallbacks: vi.fn(),
  commitLateCallbacks: vi.fn(),
  playHelpChime: vi.fn(),
  unlockHelpChime: vi.fn(),
  listen: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: 'account_admin', tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune' }] }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: (flag: string) => mocks.flags.has(flag),
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyStats', () => ({ getAgencyGroupedStats: mocks.getAgencyGroupedStats }));
vi.mock('../../api/agencyFloor', () => ({
  getAgencyFloor: mocks.getAgencyFloor,
  getAgencyPromisesSummary: mocks.getAgencyPromisesSummary,
}));
vi.mock('../../api/agency', () => ({ forceAgentAvailable: vi.fn() }));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign, transitionAgencyCampaign: vi.fn() }));
vi.mock('../../api/agencyFloorAssist', () => ({ sendSupervisorMessage: mocks.sendSupervisorMessage }));
vi.mock('../../api/agencyAssignment', () => ({
  previewLateCallbacks: mocks.previewLateCallbacks,
  commitLateCallbacks: mocks.commitLateCallbacks,
}));
vi.mock('../../utils/agency/helpChime', () => ({ playHelpChime: mocks.playHelpChime, unlockHelpChime: mocks.unlockHelpChime }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ available: false, count: null, inboundOn: true, settled: true }),
}));
vi.mock('../../components/listen/ListenProvider', () => ({
  useListen: () => ({ canListen: true, listen: mocks.listen }),
}));

import HomePage from '../../pages/agency/HomePage';
import { resetHomeAcksForTests } from '../../hooks/useHomeAcks';

const ASSIST = 'agency_floor_assist_enabled';
const ASSIGNMENT = 'agency_contact_assignment_enabled';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const RAISED = minutesAgo(2.5);

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/agency/home']}>
      <Routes>
        <Route path="/agency/home" element={<HomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function floorOf(agents: AgencyFloorAgent[]): AgencyFloorResponse {
  return { agents, totals: { on_shift: agents.length, assigned: agents.length }, as_of: new Date().toISOString() };
}

const RAVI = (help: AgencyFloorAgent['help'] = { raised_at: RAISED, call_id: 'call-1' }) => floorRow('ravi', {
  agent_name: 'Ravi Kumar',
  state: 'on_call',
  state_since: minutesAgo(3),
  call: {
    call_id: 'call-1',
    origin: 'campaign',
    correlation_id: 'att-1',
    customer_name: 'Ramesh Goud',
    connected_at: minutesAgo(3),
    aht_seconds: 600,
    listenable: true,
    not_listenable_reason: null,
  },
  help,
});
// On Tea (15 minutes) for 22: past its own limit, under the floor's 30.
const PRIYA = () => floorRow('priya', {
  agent_name: 'Priya M', state: 'break', break_reason: 'tea', break_label: 'Tea', break_limit_minutes: 15, state_since: minutesAgo(22.5),
});
const ARJUN = () => floorRow('arjun', { agent_name: 'Arjun T' });
const DIVYA = () => floorRow('divya', { agent_name: 'Divya S' });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetHomeAcksForTests();
  mocks.flags = new Set([ASSIST]);
  mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Q4 collections', stats: stats({ agents_live: 3 }) })]));
  mocks.getAgencyGroupedStats.mockResolvedValue({ rows: [], total_groups: 0 });
  mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(), PRIYA(), ARJUN()]));
  mocks.getAgencyPromisesSummary.mockResolvedValue({ campaigns: [], promise_campaign_ids: [], from: '', to: '' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cardIds = () => within(screen.getByTestId('home-agent-grid')).getAllByRole('listitem')
  .map((li) => li.getAttribute('data-testid')!.replace('home-agent-', ''));

describe('Need help (LF4, LF28)', () => {
  it('tops Needs you now, naming the agent, the campaign and how long ago, with Listen and Talk', async () => {
    renderHome();
    const row = await screen.findByTestId('home-attention-help:ravi');
    expect(row.getAttribute('data-tone')).toBe('danger');
    expect(row.textContent).toContain('Ravi Kumar pressed Need help 2 min ago');
    expect(row.textContent).toContain('Q4 collections');
    expect(row.textContent).toContain('on a call with Ramesh Goud');
    // First of all, before Priya's break.
    const list = screen.getByTestId('home-attention');
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))[0]).toBe('home-attention-help:ravi');
    // No "Got it": it ends on an answer, a cancel or expiry.
    expect(within(row).queryByRole('button', { name: /Got it/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Listen to Ravi Kumar’s call' }));
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.listen.mock.calls[0]![0]).toMatchObject({ call_id: 'call-1', customer_name: 'Ramesh Goud' });
    fireEvent.click(within(row).getByRole('button', { name: 'Talk to Ravi Kumar' }));
    expect(screen.getByRole('dialog', { name: 'Message Ravi Kumar' })).toBeTruthy();
  });

  it('turns the card red, with words, first in the grid; the chip counts and filters', async () => {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    expect(cardIds()[0]).toBe('ravi');
    const card = screen.getByTestId('home-agent-ravi');
    expect(card.getAttribute('data-stripe')).toBe('help');
    expect(screen.getByTestId('home-agent-help-ravi').textContent).toBe('Needs help');
    const chip = screen.getByTestId('home-chip-help');
    expect(chip.textContent).toBe('Need help 1');
    fireEvent.click(chip);
    expect(cardIds()).toEqual(['ravi']);
  });

  it('offers no Listen when the call cannot be listened to', async () => {
    mocks.getAgencyFloor.mockImplementation(async () => {
      const ravi = RAVI();
      return floorOf([{ ...ravi, call: { ...ravi.call!, listenable: false, not_listenable_reason: 'listen_recording_off' } }]);
    });
    renderHome();
    const row = await screen.findByTestId('home-attention-help:ravi');
    expect(within(row).queryByRole('button', { name: /Listen/ })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Talk to Ravi Kumar' })).toBeTruthy();
  });

  it('shows nothing of floor assist while its flag is off', async () => {
    mocks.flags = new Set();
    // The server sends help: null with the flag off.
    mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(null), PRIYA()]));
    renderHome();
    await screen.findByTestId('home-agent-grid');
    expect(screen.queryByTestId('home-attention-help:ravi')).toBeNull();
    expect(screen.queryByTestId('home-chip-help')).toBeNull();
    expect(screen.queryByTestId('home-help-chime')).toBeNull();
    expect(screen.queryByRole('button', { name: /Talk to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /reminder/ })).toBeNull();
  });
});

describe('the chime (LF31)', () => {
  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  }

  it('plays once per new request, never for those open at the first read or already heard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHome();
      await screen.findByTestId('home-attention-help:ravi');
      // Ravi's was open at the first read: shown, not chimed for.
      expect(mocks.playHelpChime).not.toHaveBeenCalled();
      const priya = { ...PRIYA(), help: { raised_at: minutesAgo(0), call_id: null } };
      mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(), priya, ARJUN()]));
      await poll();
      await waitFor(() => expect(mocks.playHelpChime).toHaveBeenCalledTimes(1));
      // The same requests on the next polls: nothing more.
      await poll();
      await poll();
      expect(mocks.playHelpChime).toHaveBeenCalledTimes(1);
      // Ravi's answered, then raised again: a new request.
      mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(null), priya, ARJUN()]));
      await poll();
      mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI({ raised_at: minutesAgo(0), call_id: 'call-1' }), priya, ARJUN()]));
      await poll();
      await waitFor(() => expect(mocks.playHelpChime).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('is on by default, and muted per browser stays silent for new requests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = renderHome();
      const toggle = await screen.findByTestId('home-help-chime');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      // One name whatever the state; `aria-pressed` says on or off (the visible word is hidden from it).
      expect(screen.getByRole('button', { name: 'Need help sound', pressed: true })).toBe(toggle);
      expect(toggle.textContent).toBe('Need help sound on');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByRole('button', { name: 'Need help sound', pressed: false })).toBe(toggle);
      expect(toggle.textContent).toBe('Need help sound off');
      expect(mocks.unlockHelpChime).toHaveBeenCalled();
      expect(window.localStorage.getItem('magick.liveFloor.helpChime.v1')).toBe('off');
      mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(), { ...ARJUN(), help: { raised_at: minutesAgo(0), call_id: null } }]));
      await poll();
      await screen.findByTestId('home-attention-help:arjun');
      expect(mocks.playHelpChime).not.toHaveBeenCalled();
      // The page opened again in this browser: still off.
      view.unmount();
      renderHome();
      expect((await screen.findByTestId('home-help-chime')).getAttribute('aria-pressed')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('works without storage: on by default, and the page renders', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Blocked site data: reaching `localStorage` at all throws, for every reader on the page.
      const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      renderHome();
      const toggle = await screen.findByTestId('home-help-chime');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      mocks.getAgencyFloor.mockImplementation(async () => floorOf([RAVI(), { ...ARJUN(), help: { raised_at: minutesAgo(0), call_id: null } }]));
      await poll();
      await waitFor(() => expect(mocks.playHelpChime).toHaveBeenCalledTimes(1));
      // Muting still holds for the page.
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(blocked).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Talk to agent (LF5, LF29)', () => {
  async function openTalk() {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    fireEvent.click(within(screen.getByTestId('home-agent-arjun')).getByRole('button', { name: 'Talk to Arjun T' }));
    return screen.getByRole('dialog', { name: 'Message Arjun T' });
  }

  it('sends a typed message to the agent’s session, counted, then closes', async () => {
    mocks.sendSupervisorMessage.mockResolvedValue({ id: 'm1', session_id: 's-arjun', sent_at: new Date().toISOString(), delivered: true });
    const dialog = await openTalk();
    const box = within(dialog).getByTestId('message-text');
    const send = within(dialog).getByTestId('message-send');
    // Focus in the dialog, on the text.
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: '  Offer the 3-month plan  ' } });
    expect(within(dialog).getByTestId('message-counter').textContent).toBe('22 / 500');
    fireEvent.click(send);
    await waitFor(() => expect(mocks.sendSupervisorMessage).toHaveBeenCalledWith('s-arjun', 'Offer the 3-month plan', 't-1', 'a-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.showToast).toHaveBeenCalledWith('Sent to Arjun T.', 'success');
  });

  it('holds Send past 500 characters', async () => {
    const dialog = await openTalk();
    fireEvent.change(within(dialog).getByTestId('message-text'), { target: { value: 'a'.repeat(501) } });
    expect(within(dialog).getByTestId('message-send').hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByTestId('message-counter').getAttribute('data-state')).toBe('invalid');
  });

  it.each([
    [new ApiError(409, { error: 'Conflict', code: 'agent_not_live', message: 'x' }), 'Arjun T isn’t on a station that can receive messages right now.'],
    [new ApiError(400, { error: 'Bad Request', code: 'message_invalid', message: 'x' }), 'Write a message of 1 to 500 characters.'],
    [new ApiError(403, { error: 'Forbidden', code: 'floor_assist_disabled', message: 'x' }), 'Messages to agents are turned off for this account.'],
  ])('says why a refused message was not sent, and keeps the text (%#)', async (err, words) => {
    mocks.sendSupervisorMessage.mockRejectedValue(err);
    const dialog = await openTalk();
    fireEvent.change(within(dialog).getByTestId('message-text'), { target: { value: 'Are you there?' } });
    fireEvent.click(within(dialog).getByTestId('message-send'));
    expect((await within(dialog).findByTestId('message-error')).textContent).toBe(words);
    expect((within(dialog).getByTestId('message-text') as HTMLTextAreaElement).value).toBe('Are you there?');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on Escape and gives focus back to the card’s button', async () => {
    renderHome();
    await screen.findByTestId('home-agent-grid');
    const talk = within(screen.getByTestId('home-agent-arjun')).getByRole('button', { name: 'Talk to Arjun T' });
    talk.focus();
    fireEvent.click(talk);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(talk));
  });
});

describe('Send reminder (LF5, LF6, LF29)', () => {
  it('opens prefilled with the break and its limit, still editable, from the row and the card', async () => {
    mocks.sendSupervisorMessage.mockResolvedValue({ id: 'm2', session_id: 's-priya', sent_at: new Date().toISOString(), delivered: true });
    renderHome();
    // Tea's own limit (15), not the floor's 30: the row and the card both say so.
    const row = await screen.findByTestId('home-attention-break-overrun:priya');
    expect(row.textContent).toContain('Priya M on Tea for 22 min');
    expect(row.textContent).toContain('The limit for Tea is 15 min.');
    expect(screen.getByTestId('home-agent-risk-priya').textContent).toBe('Past the 15-minute limit for Tea.');
    fireEvent.click(within(row).getByRole('button', { name: 'Send Priya M a reminder' }));
    const dialog = screen.getByRole('dialog', { name: 'Send Priya M a reminder' });
    const box = within(dialog).getByTestId('message-text') as HTMLTextAreaElement;
    expect(box.value).toBe('Hi, your Tea break (15 minutes) is over. Please come back to your station when you can. Thank you!');
    fireEvent.change(box, { target: { value: 'Priya, Tea is over, please come back.' } });
    fireEvent.click(within(dialog).getByTestId('message-send'));
    await waitFor(() => expect(mocks.sendSupervisorMessage).toHaveBeenCalledWith('s-priya', 'Priya, Tea is over, please come back.', 't-1', 'a-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(screen.getByTestId('home-agent-priya')).getByRole('button', { name: 'Send Priya M a reminder' }));
    expect((within(screen.getByRole('dialog')).getByTestId('message-text') as HTMLTextAreaElement).value).toMatch(/^Hi, your Tea break \(15 minutes\)/);
  });

  it('is refused in words when the agent has no live station', async () => {
    mocks.sendSupervisorMessage.mockRejectedValue(new ApiError(409, { error: 'Conflict', code: 'agent_not_live', message: 'x' }));
    renderHome();
    const row = await screen.findByTestId('home-attention-break-overrun:priya');
    fireEvent.click(within(row).getByRole('button', { name: 'Send Priya M a reminder' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByTestId('message-send'));
    expect((await screen.findByTestId('message-error')).textContent).toBe('Priya M isn’t on a station that can receive messages right now.');
  });
});

describe('Give late callbacks to free agents (LF7, LF30)', () => {
  const PREVIEW = (over: Partial<AgencyLateCallbacksPreview> = {}): AgencyLateCallbacksPreview => ({
    kind: 'late_callbacks_to_live_agents',
    preview_token: 'tok-1',
    seed: null,
    matched: 4,
    moving: 4,
    skipped_live: 0,
    unchanged: 0,
    to_pool: 0,
    per_agent: [
      { agent_user_id: 'divya', receiving: 2, giving: 0 },
      { agent_user_id: 'arjun', receiving: 2, giving: 0 },
      { agent_user_id: 'naveen', receiving: 0, giving: 4 },
    ],
    same_number_groups: 0,
    live_agent_user_ids: ['divya', 'arjun'],
    ...over,
  });

  beforeEach(() => {
    mocks.flags = new Set([ASSIST, ASSIGNMENT]);
    const away = onBoard('c1', { name: 'Gold loan' });
    away.allocation = { ...away.allocation!, callbacks_overdue: 4, callbacks_overdue_absent_owner: 4 };
    mocks.getAgencyHomeBoard.mockResolvedValue(board([away, onBoard('c2', { name: 'Card', overdue: 2 })]));
    mocks.getAgencyFloor.mockImplementation(async () => floorOf([ARJUN(), DIVYA()]));
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'c1', assignment_mode: 'strict' });
  });

  const lateRow = () => screen.findByTestId('home-attention-callbacks-overdue:c1');
  const giveButton = (row: HTMLElement) => within(row).findByRole('button', { name: 'Give Gold loan’s late callbacks to free agents' });

  it('previews, asks with the counts and the receivers, commits with the token, and says what moved', async () => {
    mocks.previewLateCallbacks.mockResolvedValue(PREVIEW());
    mocks.commitLateCallbacks.mockResolvedValue({
      kind: 'late_callbacks_to_live_agents', batch_id: 'b1', moved: 4, skipped_live: 0, unchanged: 0, to_pool: 0,
      per_agent: PREVIEW().per_agent,
    });
    renderHome();
    const row = await lateRow();
    fireEvent.click(await giveButton(row));
    // The mode was read once, for the campaign with away owners only.
    expect(mocks.getAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyCampaign).toHaveBeenCalledWith('c1', 't-1', 'a-1');
    expect(mocks.previewLateCallbacks).toHaveBeenCalledWith('c1', { kind: 'late_callbacks_to_live_agents' }, 't-1', 'a-1');
    const dialog = screen.getByRole('dialog', { name: 'Give late callbacks to free agents' });
    expect((await within(dialog).findByTestId('handoff-question')).textContent).toBe('Give 4 late callbacks to 2 free agents?');
    expect(within(dialog).getByTestId('handoff-receivers').textContent).toContain('Divya S, Arjun T');
    const boardReads = mocks.getAgencyHomeBoard.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give to 2 agents' }));
    await waitFor(() => expect(mocks.commitLateCallbacks).toHaveBeenCalledWith(
      'c1',
      { operation: { kind: 'late_callbacks_to_live_agents' }, preview_token: 'tok-1' },
      't-1',
      'a-1',
    ));
    expect((await within(dialog).findByTestId('handoff-result')).textContent).toBe('Gave 4 late callbacks: Divya S 2, Arjun T 2.');
    // The board is read again at once, so the late-callbacks row follows.
    await waitFor(() => expect(mocks.getAgencyHomeBoard.mock.calls.length).toBeGreaterThan(boardReads));
    fireEvent.click(within(dialog).getByTestId('handoff-done'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is not offered on a pool campaign, nor without contact assignment', async () => {
    mocks.getAgencyCampaign.mockResolvedValue({ id: 'c1', assignment_mode: 'pool' });
    const view = renderHome();
    const row = await lateRow();
    await waitFor(() => expect(mocks.getAgencyCampaign).toHaveBeenCalled());
    expect(within(row).queryByRole('button', { name: /free agents/ })).toBeNull();
    view.unmount();

    mocks.flags = new Set([ASSIST]);
    mocks.getAgencyCampaign.mockClear();
    renderHome();
    const again = await lateRow();
    expect(within(again).queryByRole('button', { name: /free agents/ })).toBeNull();
    expect(mocks.getAgencyCampaign).not.toHaveBeenCalled();
  });

  it('shows the fresh preview when the roster moved, and commits only once confirmed again', async () => {
    mocks.previewLateCallbacks.mockResolvedValue(PREVIEW());
    mocks.commitLateCallbacks
      .mockRejectedValueOnce(new ApiError(409, {
        error: 'Conflict', code: 'preview_stale', message: 'x',
        preview: PREVIEW({ preview_token: 'tok-2', moving: 3, live_agent_user_ids: ['divya'] }),
      }))
      .mockResolvedValueOnce({ kind: 'late_callbacks_to_live_agents', batch_id: 'b2', moved: 3, skipped_live: 0, unchanged: 0, to_pool: 0, per_agent: [{ agent_user_id: 'divya', receiving: 3, giving: 0 }] });
    renderHome();
    fireEvent.click(await giveButton(await lateRow()));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByTestId('handoff-question');
    fireEvent.click(within(dialog).getByTestId('handoff-give'));
    expect((await within(dialog).findByTestId('handoff-stale')).textContent).toBe(ASSIGNMENT_REFUSAL_COPY.preview_stale);
    expect(within(dialog).getByTestId('handoff-question').textContent).toBe('Give 3 late callbacks to 1 free agent?');
    expect(mocks.commitLateCallbacks).toHaveBeenCalledTimes(1);
    const confirm = within(dialog).getByTestId('handoff-give');
    expect(confirm.textContent).toBe('Give to 1 agent: confirm again');
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.commitLateCallbacks).toHaveBeenLastCalledWith(
      'c1', { operation: { kind: 'late_callbacks_to_live_agents' }, preview_token: 'tok-2' }, 't-1', 'a-1',
    ));
    expect((await within(dialog).findByTestId('handoff-result')).textContent).toBe('Gave 3 late callbacks: Divya S 3.');
  });

  it('says so when nobody is free, and offers no Give', async () => {
    mocks.previewLateCallbacks.mockResolvedValue(PREVIEW({ moving: 0, per_agent: [], live_agent_user_ids: [] }));
    renderHome();
    fireEvent.click(await giveButton(await lateRow()));
    const dialog = screen.getByRole('dialog');
    expect((await within(dialog).findByTestId('handoff-question')).textContent).toMatch(/^No agent is free on this campaign/);
    expect(within(dialog).getByTestId('handoff-give').hasAttribute('disabled')).toBe(true);
  });

  it('stops offering it when the server says the campaign became pool', async () => {
    mocks.previewLateCallbacks.mockRejectedValue(new ApiError(409, { error: 'Conflict', code: 'late_callbacks_pool_mode', message: 'x' }));
    renderHome();
    const row = await lateRow();
    fireEvent.click(await giveButton(row));
    const dialog = screen.getByRole('dialog');
    expect((await within(dialog).findByTestId('handoff-error')).textContent).toBe('This campaign shares one queue, so no agent owns its callbacks and there are none to give.');
    fireEvent.click(within(dialog).getByTestId('handoff-done'));
    expect(within(await lateRow()).queryByRole('button', { name: /free agents/ })).toBeNull();
  });

  it('says contact assignment is off when the server refuses it so', async () => {
    mocks.previewLateCallbacks.mockRejectedValue(new ApiError(403, { error: 'Forbidden', code: 'assignment_disabled', message: 'x' }));
    renderHome();
    fireEvent.click(await giveButton(await lateRow()));
    expect((await screen.findByTestId('handoff-error')).textContent).toBe('Contact assignment is turned off for this account.');
  });
});
