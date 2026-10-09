import { describe, it, expect } from 'vitest';
import {
  resolveReleaseCopy,
  releaseShape,
  isKnownReleaseReason,
} from '../../utils/agencyReleaseCopy';
import type { AgencyReleaseReason, AgencyStationReleasedFrame } from '../../types/agency';

/**
 * The release copy table is the entire mitigation for "an agent whose screen
 * clears with no explanation concludes the app is broken" — which at volume is
 * a support ticket per unanswered call.
 */

/** Every member of the contract's union. Kept explicit so adding one to the
 *  type without adding copy fails here rather than at runtime. */
const ALL_REASONS: AgencyReleaseReason[] = [
  'completed',
  'no_answer',
  'busy',
  'failed',
  'invalid',
  'abandoned',
  'agent_disconnected',
  'reservation_expired',
  'agent_hangup',
  'remote_hangup',
  'campaign_paused',
  'campaign_stopped',
  'supervisor_released',
  'orphaned',
];

function frame(overrides: Partial<AgencyStationReleasedFrame> = {}): AgencyStationReleasedFrame {
  return {
    event: 'released',
    attempt_id: 'a1',
    reason: 'completed',
    requires_disposition: true,
    message: 'server fallback copy',
    ...overrides,
  };
}

describe('release copy — exhaustive over the contract union', () => {
  it.each(ALL_REASONS)('has non-empty headline and subtext for %s', (reason) => {
    const copy = resolveReleaseCopy(frame({ reason }));
    expect(copy.headline.trim()).not.toBe('');
    expect(copy.subtext.trim()).not.toBe('');
  });

  it.each(ALL_REASONS)('never renders an enum-shaped token for %s', (reason) => {
    // "No reason renders a raw code" means no IDENTIFIER leaks into copy. It
    // cannot mean "the copy never contains the reason's letters": `busy` and
    // `failed` are ordinary English words, and "Line busy" is the correct
    // sentence. The testable form of the rule is that no snake_case token
    // appears — that is what an enum looks like on screen.
    const copy = resolveReleaseCopy(frame({ reason }));
    const text = `${copy.headline} ${copy.subtext}`;
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it.each(ALL_REASONS.filter((r) => r.includes('_')))(
    'never renders the multi-word code %s as-is',
    (reason) => {
      const copy = resolveReleaseCopy(frame({ reason }));
      expect(`${copy.headline} ${copy.subtext}`).not.toContain(reason);
    },
  );

  it('recognises every union member', () => {
    for (const reason of ALL_REASONS) expect(isKnownReleaseReason(reason)).toBe(true);
  });
});

describe('release copy — the fallback, tested with a deliberately bogus reason', () => {
  // The API ships independently of the console, so an unrecognised reason is
  // EXPECTED traffic after an API deploy, not a defect.
  const bogus = frame({
    reason: 'quantum_entangled' as AgencyReleaseReason,
    message: 'The call ended for a reason this app does not know about.',
  });

  it('still produces a headline — never an empty panel', () => {
    const copy = resolveReleaseCopy(bogus);
    expect(copy.headline).toBe('Call ended');
    expect(copy.tone).toBe('neutral');
  });

  it('uses the server message as subtext', () => {
    expect(resolveReleaseCopy(bogus).subtext).toBe(
      'The call ended for a reason this app does not know about.',
    );
  });

  it('still produces a headline when the server message is empty too', () => {
    const copy = resolveReleaseCopy(
      frame({ reason: 'nonsense' as AgencyReleaseReason, message: '   ' }),
    );
    expect(copy.headline).toBe('Call ended');
    expect(copy.subtext.trim()).not.toBe('');
  });

  it('never leaks the unknown code into the copy', () => {
    const copy = resolveReleaseCopy(bogus);
    expect(`${copy.headline} ${copy.subtext}`).not.toContain('quantum_entangled');
  });

  it('reports an unknown reason so it can be logged to diagnostics', () => {
    expect(isKnownReleaseReason('quantum_entangled')).toBe(false);
  });
});

describe('release shape', () => {
  it('branches on requires_disposition, NEVER on the reason', () => {
    // The API decides whether the call actually reached the agent — it is the only
    // side that can know. Same reason, both shapes.
    expect(releaseShape(frame({ reason: 'completed', requires_disposition: true }))).toBe('wrapup');
    expect(releaseShape(frame({ reason: 'completed', requires_disposition: false }))).toBe(
      'dim_and_clear',
    );
  });

  it('holds for a reason this build does not recognise', () => {
    expect(
      releaseShape(frame({ reason: 'nonsense' as AgencyReleaseReason, requires_disposition: true })),
    ).toBe('wrapup');
  });
});

describe('copy rules', () => {
  it('never promises the same agent will make the callback', () => {
    // Shared pool: a callback re-enters the roster as an ordinary pending contact and
    // whichever agent is available takes it. First-person-singular copy is a
    // promise the system cannot keep, and the copy IS the entire mitigation.
    for (const reason of ALL_REASONS) {
      const copy = resolveReleaseCopy(frame({ reason }));
      const text = `${copy.headline} ${copy.subtext}`;
      expect(text).not.toMatch(/\bI'll\b/i);
      expect(text).not.toMatch(/\bI will\b/i);
    }
  });

  it('says "we" in every retry promise', () => {
    for (const reason of ['no_answer', 'busy', 'failed'] as AgencyReleaseReason[]) {
      expect(resolveReleaseCopy(frame({ reason })).subtext).toContain("We'll try again later");
    }
  });
});
