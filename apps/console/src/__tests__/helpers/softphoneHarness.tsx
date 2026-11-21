import { vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSoftphone, type SoftphoneAudio } from '../../hooks/useSoftphone';
import { SoftphoneScreen } from '../../components/softphone/StationSoftphone';
import { SIDE_COPY } from '../../utils/agency/sideViewCopy';
import { serverClock } from '../../hooks/useServerClock';
import type { RingbackTone } from '../../utils/softphone/ringback';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';

/**
 * The soft phone rendered whole for a test: `useSoftphone` driven by `manual_call` frames into
 * `SoftphoneScreen` (the soft phone in the station's look, both hosts' screen), with stubbed ringback, audio and clock. A suite using it mocks
 * `api/softphone` itself (`vi.mock` in the suite). Kept apart from `softphone.ts`'s plain
 * fixtures, so the suites that need only those do not load the view.
 */

export function fakeRingback() {
  return {
    unlock: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    close: vi.fn(),
    playing: false,
  } as unknown as RingbackTone & Record<'unlock' | 'start' | 'stop' | 'setMuted' | 'close', ReturnType<typeof vi.fn>>;
}

/** The call audio's stub; a suite that asserts on it resets its mocks itself. */
export const audio = { muted: false, sending: false, toggleMute: vi.fn(), resume: vi.fn() };
export const clock = serverClock(0);

export interface HarnessProps {
  frameCall: AgencyManualCall | null;
  connection?: StationConnection;
  ringback: RingbackTone;
  presetCampaignId?: string | null;
  presetNumber?: string | null;
  audioState?: SoftphoneAudio;
  startAllowed?: boolean;
  fromCampaign?: boolean;
  /** The station's `phone_display` the frame carries (AS9). */
  phoneDisplay?: 'full' | 'masked';
}

export function Harness({
  frameCall,
  connection = 'open',
  ringback,
  presetCampaignId = null,
  presetNumber = null,
  audioState = audio,
  startAllowed = true,
  fromCampaign = false,
  phoneDisplay = 'full',
}: HarnessProps) {
  const sp = useSoftphone({
    tenantId: 't-1',
    accountId: 'a-1',
    userId: 'u-1',
    sessionId: 'sess-sp',
    connection,
    frameCall,
    clock,
    audio: audioState,
    surface: 'softphone_page',
    ringback,
    presetCampaignId,
    presetNumber,
    startAllowed,
  });
  return (
    <MemoryRouter>
      <SoftphoneScreen
        sp={sp}
        connection={connection}
        clock={clock}
        testId="softphone-screen"
        inboundNote={fromCampaign ? SIDE_COPY.inboundNotHere : SIDE_COPY.inboundNotHerePage}
        frame={{
          agentName: 'Priya Nair',
          workName: null,
          brandMark: 'MA',
          needHelp: null,
          menu: () => null,
          banners: null,
          cueFlash: null,
          phoneDisplay,
          readAloud: { available: false, say: () => {} },
        }}
        wayOut={{ button: null, reason: null }}
      />
    </MemoryRouter>
  );
}

/**
 * Renders the harness with no call and lets the bootstrap settle. `frame` re-renders it with
 * the call the station socket would carry next (and, optionally, a changed connection).
 */
export async function mount(props: Omit<HarnessProps, 'frameCall'>) {
  const view = render(<Harness frameCall={null} {...props} />);
  await act(async () => {});
  return {
    ...view,
    frame: async (frameCall: AgencyManualCall | null, connection: StationConnection = 'open') => {
      view.rerender(<Harness frameCall={frameCall} connection={connection} {...props} />);
      await act(async () => {});
    },
  };
}
