import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  flags: new Set<string>(),
  api: {
    getSoftphoneBootstrap: vi.fn(),
    listManualCalls: vi.fn(),
    placeManualCall: vi.fn(),
    updateManualCall: vi.fn(),
    hangupManualCall: vi.fn(),
    dispositionManualCall: vi.fn(),
    markManualCallDnc: vi.fn(),
  },
}));
vi.mock('../../api/softphone', () => mocks.api);
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));

import { useSoftphone } from '../../hooks/useSoftphone';
import { SoftphoneView } from '../../components/softphone/SoftphoneView';
import { SOFTPHONE_INBOUND_NOTICE } from '../../components/softphone/SoftphoneInboundNotice';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { serverClock } from '../../hooks/useServerClock';
import type { RingbackTone } from '../../utils/softphone/ringback';
import type { AgencyManualCall } from '../../types/softphone';
import { BOOTSTRAP, manualCall, step } from '../helpers/softphone';

/**
 * The stopgap note on the soft phone (`docs/softphone.md` §7, `docs/inbound.md` §12 P3): an
 * agent on the soft phone is never offered an inbound caller, so with inbound calls on for the
 * account the dial pad says so, and where to go to take them. With inbound off it says nothing.
 */

const ringback = {
  unlock: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  setMuted: vi.fn(),
  setVolume: vi.fn(),
  close: vi.fn(),
  playing: false,
} as unknown as RingbackTone;
const audio = { muted: false, sending: false, toggleMute: vi.fn(), resume: vi.fn() };
const clock = serverClock(0);

function Harness({
  frameCall,
  fromCampaign = false,
  startAllowed = true,
}: {
  frameCall: AgencyManualCall | null;
  fromCampaign?: boolean;
  startAllowed?: boolean;
}) {
  const sp = useSoftphone({
    tenantId: 't-1',
    accountId: 'a-1',
    userId: 'u-1',
    sessionId: 'sess-sp',
    connection: 'open',
    frameCall,
    clock,
    audio,
    surface: 'softphone_page',
    ringback,
    presetCampaignId: null,
    presetNumber: null,
    startAllowed,
  });
  return (
    <MemoryRouter>
      <SoftphoneView sp={sp} connection="open" clock={clock} fromCampaign={fromCampaign} />
    </MemoryRouter>
  );
}

async function mount(props: { fromCampaign?: boolean; startAllowed?: boolean } = {}) {
  const view = render(<Harness frameCall={null} {...props} />);
  await act(async () => {});
  return {
    frame: async (frameCall: AgencyManualCall | null) => {
      view.rerender(<Harness frameCall={frameCall} {...props} />);
      await act(async () => {});
    },
  };
}

const notice = () => screen.queryByTestId('softphone-inbound-notice');

beforeEach(() => {
  mocks.flags = new Set();
  Object.values(mocks.api).forEach((m) => m.mockReset());
  mocks.api.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
  mocks.api.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 8 });
  mocks.api.updateManualCall.mockImplementation(async () => ({ ok: true, value: manualCall() }));
});

afterEach(cleanup);

describe('the soft phone’s inbound note', () => {
  it('is not shown while the account has inbound calls off', async () => {
    await mount();
    expect(screen.getByTestId('dial-call')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it('is shown under Call on a soft-phone session while inbound calls are on, as a note', async () => {
    mocks.flags.add(INBOUND_FLAG);
    await mount();
    const note = notice();
    expect(note).not.toBeNull();
    expect(note!.getAttribute('role')).toBe('note');
    expect(note!.textContent).toBe(`${SOFTPHONE_INBOUND_NOTICE.lead} ${SOFTPHONE_INBOUND_NOTICE.page}`);
    expect(note!.textContent).toBe(
      'Inbound calls don’t ring on the soft phone. They go to agents on a campaign station, or to Missed calls if none is free. Join a campaign to take them.',
    );
    // After Call in the dial column, so it never pushes the keypad down on a narrow screen.
    const call = screen.getByTestId('dial-call');
    expect(call.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Dial' }).contains(note)).toBe(true);
  });

  it('on a campaign switched to the soft phone it sends the agent back to their campaign', async () => {
    mocks.flags.add(INBOUND_FLAG);
    await mount({ fromCampaign: true });
    expect(notice()!.textContent).toBe(`${SOFTPHONE_INBOUND_NOTICE.lead} ${SOFTPHONE_INBOUND_NOTICE.station}`);
    expect(notice()!.textContent).toMatch(/Return to your campaign to take them\.$/);
  });

  it('gives way to the call once one is placed, and comes back when it settles', async () => {
    mocks.flags.add(INBOUND_FLAG);
    const queued = manualCall();
    mocks.api.placeManualCall.mockResolvedValue({ ok: true, value: queued });
    const view = await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    await view.frame(step(queued, 2, { state: 'ringing' }));
    expect(notice()).toBeNull();
    // A ring that went unanswered settles on its own (no outcome owed): Ready again.
    await view.frame(step(queued, 30, { state: 'ended', outcome: 'no_answer', end_reason: 'no_answer', settled_at: '2026-10-30T10:00:30Z' }));
    expect(screen.getByTestId('rail-label').textContent).toBe('Ready to dial');
    expect(screen.getByTestId('dial-call')).toBeTruthy();
    expect(notice()).not.toBeNull();
  });

  it('is not shown in finish mode, where no new call can start', async () => {
    mocks.flags.add(INBOUND_FLAG);
    await mount({ startAllowed: false });
    expect(screen.getByTestId('softphone-finish-notice')).toBeTruthy();
    expect(notice()).toBeNull();
  });
});
