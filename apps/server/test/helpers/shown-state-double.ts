/**
 * `AgencyDialer.shownStateFor` for a dialer double: the real rule (`shownAgentState`, the
 * pure function the dialer itself asks) over the double's own `hasUnannouncedAttempt`, so a
 * test that stages a hidden dial with that one stub gets both halves of the behaviour, the
 * suppressed `agent_state` frame and the `available` in the answer, from one switch.
 *
 * Added onto the double in place (and returned), so the stub it reads is the one the test
 * re-mocks later.
 */
import { vi, type Mock } from 'vitest';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import { shownAgentState } from '../../src/agency/dialer/live-attempt.js';

export function withShownState<D extends { hasUnannouncedAttempt: (sessionId: string) => boolean }>(
  dialer: D,
): D & { shownStateFor: Mock<(sessionId: string, state: AgencyAgentState) => AgencyAgentState> } {
  return Object.assign(dialer, {
    shownStateFor: vi.fn((sessionId: string, state: AgencyAgentState) =>
      shownAgentState(state, dialer.hasUnannouncedAttempt(sessionId))),
  });
}
