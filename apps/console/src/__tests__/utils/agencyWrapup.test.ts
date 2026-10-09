import { describe, it, expect } from 'vitest';
import { openWrapup, wrapupView, announcementThreshold, hasWrapup } from '../../utils/agencyWrapup';
import type { AgencyWrapupState } from '../../types/agency';

const ATTEMPT = 'attempt-1';

function frame(overrides: Partial<AgencyWrapupState> = {}): AgencyWrapupState {
  return {
    attempt_id: ATTEMPT,
    ends_at: '2026-08-11T12:00:30.000Z',
    requires_disposition: true,
    disposition_submitted: false,
    auto_return: true,
    ...overrides,
  };
}

const OPENED_AT = Date.parse('2026-08-11T12:00:00.000Z');

describe('openWrapup — the anchor is captured once', () => {
  it('reads the absolute ends_at rather than reconstructing it', () => {
    const anchor = openWrapup(frame(), 0, OPENED_AT);
    expect(anchor.deadlineMs).toBe(Date.parse('2026-08-11T12:00:30.000Z'));
    expect(anchor.totalMs).toBe(30_000);
  });

  /**
   * **The assertion that catches a reconstructed deadline.** In the happy path
   * `ends_at` and `since + wrapup_seconds` agree, so every other test passes
   * whichever way the deadline was derived. Only a frame where they disagree
   * tells the two implementations apart — and `ends_at` is authoritative.
   */
  it('follows ends_at when it disagrees with since + wrapup_seconds', () => {
    // A campaign configured for 30s, but core says the window ends in 45s
    // (a wrap-up extended because a disposition is required, say).
    const anchor = openWrapup(frame({ ends_at: '2026-08-11T12:00:45.000Z' }), 0, OPENED_AT);

    expect(anchor.totalMs).toBe(45_000);
    // Explicitly NOT the reconstructed value.
    expect(anchor.totalMs).not.toBe(30_000);

    const view = wrapupView(anchor, OPENED_AT, false);
    expect(view.label).toBe('0:45');
  });

  it('applies the clock offset — absolute does not mean trustworthy', () => {
    // Machine 90s fast: server_ts trails client time by 90s.
    const anchor = openWrapup(frame(), -90_000, OPENED_AT + 90_000);
    // The deadline lands 90s later in client terms, so the span is still 30s.
    expect(anchor.totalMs).toBe(30_000);
    expect(wrapupView(anchor, OPENED_AT + 90_000, false).label).toBe('0:30');
  });

  it('yields no deadline and no span for ends_at: null', () => {
    // Legitimate, and means "no deadline — ends when the agent acts". Never
    // "expired": rendering it as a zero countdown tells the agent they are out
    // of time when they are not.
    const anchor = openWrapup(frame({ ends_at: null, auto_return: false }), 0, OPENED_AT);
    expect(anchor.deadlineMs).toBeNull();
    expect(anchor.totalMs).toBeNull();

    const view = wrapupView(anchor, OPENED_AT, false);
    expect(view.remainingMs).toBeNull();
    expect(view.label).toBeNull();
    expect(view.fraction).toBeNull();
  });

  it('does not invert the bar when the frame arrives after its own deadline', () => {
    const anchor = openWrapup(frame(), 0, Date.parse('2026-08-11T12:00:40.000Z'));
    expect(anchor.totalMs).toBeNull();
  });
});

describe('wrapupView — recomputed from the anchor, never decremented', () => {
  const anchor = openWrapup(frame(), 0, OPENED_AT);

  it('is a pure function of the anchor and now', () => {
    // The interval is a repaint trigger, not a time source: calling this a
    // hundred times at one instant must not advance anything.
    const at = OPENED_AT + 10_000;
    const once = wrapupView(anchor, at, false);
    for (let i = 0; i < 100; i += 1) wrapupView(anchor, at, false);
    expect(wrapupView(anchor, at, false)).toEqual(once);
  });

  it('survives a clock that jumps, because nothing accumulates', () => {
    // A decrementing implementation would be permanently wrong after a jump.
    expect(wrapupView(anchor, OPENED_AT + 5_000, false).label).toBe('0:25');
    expect(wrapupView(anchor, OPENED_AT + 25_000, false).label).toBe('0:05');
    // Jump backwards (NTP correction mid-wrap-up).
    expect(wrapupView(anchor, OPENED_AT + 5_000, false).label).toBe('0:25');
  });

  it('shrinks the bar against the span captured at open', () => {
    // The bug this pins: recomputing `total` per repaint makes both terms shrink
    // together, so the bar sits at 100% and then snaps to zero — a frozen UI.
    expect(wrapupView(anchor, OPENED_AT, false).fraction).toBe(1);
    expect(wrapupView(anchor, OPENED_AT + 15_000, false).fraction).toBeCloseTo(0.5, 5);
    expect(wrapupView(anchor, OPENED_AT + 30_000, false).fraction).toBe(0);
  });

  it('holds at zero when a required disposition is outstanding', () => {
    const view = wrapupView(anchor, OPENED_AT + 40_000, false);
    expect(view.remainingMs).toBe(0);
    expect(view.label).toBe('0:00');
    expect(view.holding).toBe(true);
  });

  it('keeps the track once the countdown reaches zero — a bar that really ran down', () => {
    // Deliberate asymmetry with the held panel: fraction 0, not null. A timer
    // that drained to nothing is a true statement about a real timer, so its
    // geometry stays.
    const view = wrapupView(anchor, OPENED_AT + 40_000, false);
    expect(view.panel).toBe('counting');
    expect(view.fraction).toBe(0);
    expect(view.fraction).not.toBeNull();
  });

  it('never counts negative or shows an overrun', () => {
    // An "over by 0:47" readout is a surveillance surface whose effect is
    // rushed, low-quality dispositions — the exact data failure wrap-up exists
    // to prevent.
    const view = wrapupView(anchor, OPENED_AT + 600_000, false);
    expect(view.remainingMs).toBe(0);
    expect(view.label).toBe('0:00');
  });

  it('does not hold once the disposition is submitted', () => {
    expect(wrapupView(anchor, OPENED_AT + 40_000, true).holding).toBe(false);
  });

  it('does not hold when no disposition is required', () => {
    const noDispo = openWrapup(frame({ requires_disposition: false }), 0, OPENED_AT);
    expect(wrapupView(noDispo, OPENED_AT + 40_000, false).holding).toBe(false);
  });
});

describe('the timerless wrap-up — wrapup_seconds = 0 with a required disposition', () => {
  /**
   * `wrapup_seconds = 0` means "no timer", **not** "no wrap-up". When a
   * disposition is required core emits a wrap-up frame that is held from the
   * very first frame: `ends_at: null`, `held_reason` set at entry, ended only by
   * the agent submitting or a supervisor forcing return.
   *
   * (The case this replaced was worse than a missing feature: `released` said
   * `requires_disposition: true` while the agent was handed straight back to the
   * pool, so every attempt on such a campaign swept to `no_disposition`.)
   */
  const timerless = frame({
    ends_at: null,
    held_reason: 'disposition_required',
    auto_return: false,
  });

  it('is held from the first frame, with no countdown', () => {
    const anchor = openWrapup(timerless, 0, OPENED_AT);
    const view = wrapupView(anchor, OPENED_AT, false);

    expect(view.holding).toBe(true);
    // Held, but emphatically not "0:00" — there is nothing to count.
    expect(view.label).toBeNull();
    expect(view.fraction).toBeNull();
  });

  it('carries the reason at entry, because no countdown could ever lapse into one', () => {
    // Without it the agent faces a panel with no deadline, no timer and nothing
    // saying why it is open.
    expect(openWrapup(timerless, 0, OPENED_AT).heldReason).toBe('disposition_required');
  });

  it('reports auto_return from the FRAME, not the campaign config', () => {
    // The campaign here sets auto-return true; core reports false because with
    // no window it cannot mean what it says. `auto_return: true` beside
    // `ends_at: null` would be indistinguishable from "the countdown failed to
    // arrive", and the console would render a spinner on a wrap-up that is
    // actually waiting for the agent.
    const anchor = openWrapup(timerless, 0, OPENED_AT);
    expect(anchor.autoReturn).toBe(false);
    expect(anchor.deadlineMs).toBeNull();
  });

  it('stops holding once the disposition is submitted', () => {
    const anchor = openWrapup(timerless, 0, OPENED_AT);
    expect(wrapupView(anchor, OPENED_AT, true).holding).toBe(false);
  });

  it('does not hold for a deadline-less wrap-up with no held reason', () => {
    // Auto-return simply off: no deadline, but nothing is blocking the agent.
    const anchor = openWrapup(frame({ ends_at: null, auto_return: false }), 0, OPENED_AT);
    expect(wrapupView(anchor, OPENED_AT, false).holding).toBe(false);
  });
});

describe('the held panel — §A.13.5.1', () => {
  /**
   * All sources of `ends_at: null` collapse onto ONE panel with one meaning:
   * *no deadline; ends when you act.* Not branched per source — the agent's next
   * action is identical in every case, and three phrasings would be three chances
   * to get one wrong.
   */
  const sources = [
    ['timerless with a required disposition', frame({ ends_at: null, held_reason: 'disposition_required', auto_return: false })],
    ['auto-return off', frame({ ends_at: null, auto_return: false })],
    ['a timer that lapsed into a hold', frame({ ends_at: null, held_reason: 'disposition_required', auto_return: true })],
  ] as const;

  it.each(sources)('renders the same held panel for %s', (_label, wrapupFrame) => {
    const view = wrapupView(openWrapup(wrapupFrame, 0, OPENED_AT), OPENED_AT, false);
    expect(view.panel).toBe('held');
    expect(view.label).toBeNull();
    expect(view.remainingMs).toBeNull();
  });

  it('renders NO bar and NO empty track when held', () => {
    // A track that will never move again is a progress indicator for a process
    // with no progress — worse than absent, because it reads as a stalled
    // countdown and the agent waits for it instead of acting.
    for (const [, wrapupFrame] of sources) {
      const view = wrapupView(openWrapup(wrapupFrame, 0, OPENED_AT), OPENED_AT, false);
      expect(view.fraction).toBeNull();
    }
  });

  it('is indistinguishable across sources in everything the agent can see', () => {
    const views = sources.map(([, f]) =>
      wrapupView(openWrapup(f, 0, OPENED_AT), OPENED_AT, false),
    );
    const visible = views.map((v) => ({ panel: v.panel, label: v.label, fraction: v.fraction }));
    expect(visible[1]).toEqual(visible[0]);
    expect(visible[2]).toEqual(visible[0]);
  });
});

describe('a frame carrying null is NOT the same state as no frame', () => {
  /**
   * An earlier version of the spec said a held wrap-up and a missing wrap-up
   * frame were indistinguishable and should be treated identically. That is now
   * explicitly false, and the two must not share a code path.
   *
   * Conflating them means either showing a wrap-up panel to an agent who is
   * already `available` and about to be reserved, or hiding a genuinely held
   * window behind a "waiting for the deadline" state that never resolves.
   */
  it('a frame with ends_at: null is a real wrap-up', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'disposition_required', auto_return: false }), 0, OPENED_AT);
    expect(hasWrapup(anchor)).toBe(true);
    expect(wrapupView(anchor, OPENED_AT, false).panel).toBe('held');
  });

  it('no frame is no wrap-up at all — there is no anchor to render from', () => {
    // Structurally separate rather than a flag: `openWrapup` only exists to be
    // called ON a frame, so "no frame" cannot produce an anchor.
    expect(hasWrapup(null)).toBe(false);
  });

  it('the two are distinguishable, which is the whole point', () => {
    const held = openWrapup(frame({ ends_at: null, auto_return: false }), 0, OPENED_AT);
    expect(hasWrapup(held)).not.toBe(hasWrapup(null));
  });
});

describe('announcementThreshold', () => {
  it('fires once at 10s and once at 3s, on the crossing', () => {
    // Computed from a crossing rather than equality because a 250ms repaint
    // will never land exactly on 10000ms.
    expect(announcementThreshold(10_200, 9_950)).toBe(10);
    expect(announcementThreshold(3_100, 2_900)).toBe(3);
  });

  it('does not re-fire on subsequent repaints inside the same band', () => {
    expect(announcementThreshold(9_950, 9_700)).toBeNull();
    expect(announcementThreshold(2_900, 2_650)).toBeNull();
  });

  it('announces nothing at any other threshold', () => {
    // The assertive region is not a metronome.
    expect(announcementThreshold(30_000, 29_750)).toBeNull();
    expect(announcementThreshold(5_100, 4_900)).toBeNull();
    expect(announcementThreshold(1_100, 900)).toBeNull();
  });

  it('is null when either side is unknown', () => {
    expect(announcementThreshold(null, 9_000)).toBeNull();
    expect(announcementThreshold(10_500, null)).toBeNull();
  });
});

/**
 * NEW (magick-agency, CONTRACT-DIFF §1): core's second hold reason,
 * `supervisor_hold` — "a supervisor is holding this agent out of the pool
 * deliberately". cusui's union lacked it. Unlike `disposition_required` it is not
 * the agent's to end, so saving the disposition must not clear it.
 */
describe('supervisor_hold — held by somebody else', () => {
  const held = frame({ ends_at: null, held_reason: 'supervisor_hold', auto_return: false });

  it('carries the reason at entry', () => {
    expect(openWrapup(held, 0, OPENED_AT).heldReason).toBe('supervisor_hold');
  });

  it('holds with no countdown, before and AFTER the disposition is submitted', () => {
    const anchor = openWrapup(held, 0, OPENED_AT);
    expect(wrapupView(anchor, OPENED_AT, false).holding).toBe(true);
    expect(wrapupView(anchor, OPENED_AT, true).holding).toBe(true);
    expect(wrapupView(anchor, OPENED_AT, true).fraction).toBeNull();
  });

  it('holds over a running countdown too, regardless of the disposition', () => {
    const anchor = openWrapup(
      frame({ held_reason: 'supervisor_hold', requires_disposition: false }),
      0,
      OPENED_AT,
    );
    expect(wrapupView(anchor, OPENED_AT + 5_000, true).holding).toBe(true);
  });
});
