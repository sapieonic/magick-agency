import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WrapupTimer, WRAPUP_HELD_FALLBACK_COPY } from '../../components/agency/WrapupTimer';
import { openWrapup } from '../../utils/agencyWrapup';
import type { AgencyWrapupState } from '../../types/agency';

/**
 * `WrapupTimer` — acceptance criterion (b)'s visible half.
 *
 * The assertion explicitly asks for is a **negative** one: a held wrap-up
 * renders *no track element at all*, not a track of zero width. The spec says why
 * in as many words — "a test asserting `width === 0` passes in both designs and is
 * therefore worthless here" — so every held-panel test below queries for absence.
 */

const T0 = Date.parse('2026-08-11T12:00:00.000Z');

function frame(overrides: Partial<AgencyWrapupState> = {}): AgencyWrapupState {
  return {
    attempt_id: 'attempt-a',
    ends_at: new Date(T0 + 30_000).toISOString(),
    requires_disposition: true,
    disposition_submitted: false,
    held_reason: null,
    auto_return: true,
    ...overrides,
  };
}

const track = () => screen.queryByTestId('wrapup-track');
const digits = () => screen.queryByTestId('wrapup-digits');
const fill = () => screen.getByTestId('wrapup-fill');
const scaleX = () => Number(/scaleX\(([-\d.]+)\)/.exec(fill().getAttribute('style') ?? '')?.[1]);

afterEach(cleanup);

describe('the timed wrap-up — bar, digits, and a span captured once', () => {
  it('renders the deadline it was given, to the exact second', () => {
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(digits()?.textContent).toBe('0:30');
    expect(track()).not.toBeNull();
  });

  it('drains the bar as the clock advances, against the span captured at open', () => {
    // `totalMs` is captured ONCE on the frame. Recomputing it per repaint gives a
    // bar pinned at 100% that snaps to zero — a frozen-looking UI that survives
    // review because the digits beside it count down correctly the whole time.
    const anchor = openWrapup(frame(), 0, T0);
    const { rerender } = render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(scaleX()).toBe(1);

    rerender(<WrapupTimer anchor={anchor} now={T0 + 15_000} dispositionSubmitted={false} />);
    expect(scaleX()).toBe(0.5);
    expect(digits()?.textContent).toBe('0:15');

    rerender(<WrapupTimer anchor={anchor} now={T0 + 22_500} dispositionSubmitted={false} />);
    expect(scaleX()).toBe(0.25);
    expect(digits()?.textContent).toBe('0:07');
  });

  it('follows ends_at even when it disagrees with since + wrapup_seconds', () => {
    // names this as the one assertion that catches a reconstructed
    // deadline — every other test passes either way, because the two agree in the
    // happy path. Here the campaign's `wrapup_seconds` would say 30s and the
    // frame says 45s; `ends_at` is authoritative.
    const anchor = openWrapup(frame({ ends_at: new Date(T0 + 45_000).toISOString() }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(digits()?.textContent).toBe('0:45');
  });

  it('applies the clock offset to the deadline', () => {
    // Absolute does not mean trustworthy in client time: a machine four minutes
    // fast renders a deadline four minutes off unless corrected. The two
    // mechanisms are complements, not alternatives.
    const anchor = openWrapup(frame(), 10_000, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(digits()?.textContent).toBe('0:20');
  });
});

describe('the hold at 0:00 — the track STAYS', () => {
  it('holds at zero without counting negative', () => {
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0 + 47_000} dispositionSubmitted={false} />);

    // Not "-0:17". An overrun readout is a surveillance surface pointed at the
    // agent, and its effect is rushed, low-quality dispositions.
    expect(digits()?.textContent).toBe('0:00');
    expect(digits()?.textContent).not.toContain('-');
  });

  it('keeps the track so the geometry does not collapse', () => {
    // The deliberate asymmetry with the held panel: a bar that genuinely ran down
    // to nothing is a true statement about a real timer.
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0 + 47_000} dispositionSubmitted={false} />);
    expect(track()).not.toBeNull();
    expect(scaleX()).toBe(0);
  });

  it('states why it is waiting', () => {
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0 + 47_000} dispositionSubmitted={false} />);
    expect(screen.getByTestId('wrapup-held-reason').textContent).toBe('Waiting on a disposition');
  });

  it('stops holding once the disposition is in', () => {
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0 + 47_000} dispositionSubmitted />);
    expect(screen.queryByTestId('wrapup-held-reason')).toBeNull();
  });
});

describe('the held wrap-up — ends_at: null renders NO track', () => {
  /**
   * Three unrelated sources, one meaning, and the console must not tell them
   * apart: auto-return off; a timed window that lapsed into a hold; and the
   * timerless `wrapup_seconds = 0` case that was held from its very first frame.
   * The agent's next action is identical in all three, and three phrasings for one
   * situation is three chances to write one of them wrong.
   */
  const sources: [string, AgencyWrapupState][] = [
    ['auto-return off', frame({ ends_at: null, auto_return: false, held_reason: null })],
    ['lapsed into a hold', frame({ ends_at: null, held_reason: 'disposition_required' })],
    [
      'timerless from the first frame',
      frame({ ends_at: null, held_reason: 'disposition_required', auto_return: false }),
    ],
  ];

  it.each(sources)('renders no track element at all — %s', (_name, state) => {
    // THE assertion of this file. `expect(width).toBe(0)` passes in both designs
    // and proves nothing; absence is the only thing that discriminates.
    const anchor = openWrapup(state, 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(track()).toBeNull();
    expect(screen.queryByTestId('wrapup-fill')).toBeNull();
  });

  it.each(sources)('renders no digits — %s', (_name, state) => {
    const anchor = openWrapup(state, 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(digits()).toBeNull();
  });

  it('never says expired, overdue, or shows a spinner', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'disposition_required' }), 0, T0);
    const { container } = render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    const text = container.textContent?.toLowerCase() ?? '';
    expect(text).not.toContain('expired');
    expect(text).not.toContain('overdue');
    expect(text).not.toContain('0:00');
  });

  it('renders held_reason even when no countdown could ever have lapsed', () => {
    // Case 3: `wrapup_seconds = 0` with a required disposition. The server sets the
    // reason on the FIRST frame precisely because there is no expiry to produce
    // one later — gate the sub-text on the countdown reaching zero and this panel
    // has no deadline AND no stated reason, which answers none of the questions
    // an agent actually has.
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'disposition_required' }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(screen.getByTestId('wrapup-held-reason').textContent).toBe('Waiting on a disposition');
  });

  it('falls back to a sentence rather than showing a raw enum', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: null }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    const shown = screen.getByTestId('wrapup-held-reason').textContent;
    expect(shown).toBe(WRAPUP_HELD_FALLBACK_COPY);
    expect(shown).not.toBe('disposition_required');
  });

  it('does not branch its copy on which source produced the null', () => {
    const rendered = sources.map(([, state]) => {
      cleanup();
      const anchor = openWrapup(state, 0, T0);
      const { container } = render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
      return container.textContent;
    });
    expect(new Set(rendered).size).toBe(1);
  });
});

describe('the countdown does not announce on every repaint', () => {
  it('hides the digits and the bar from the rail’s live region', () => {
    // The rail is this screen's ONLY polite live region. Digits inside it
    // that are not `aria-hidden` announce four times a second for the length of
    // every wrap-up of the shift, and a screen-reader user starts ignoring the
    // region that matters.
    const anchor = openWrapup(frame(), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(digits()?.getAttribute('aria-hidden')).toBe('true');
    expect(track()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves the held reason announceable — it changes once, not continuously', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'disposition_required' }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(screen.getByTestId('wrapup-held-reason').getAttribute('aria-hidden')).toBeNull();
  });
});

/** A supervisor hold: a wrap-up with no end time must still render, not vanish. */
describe('supervisor_hold', () => {
  it('names the supervisor, not the agent’s own outstanding disposition', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'supervisor_hold' }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted={false} />);
    expect(screen.getByTestId('wrapup-held-reason').textContent).toBe('Held by your supervisor');
    expect(track()).toBeNull();
  });

  it('keeps saying so after the agent has saved the disposition', () => {
    const anchor = openWrapup(frame({ ends_at: null, held_reason: 'supervisor_hold' }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0} dispositionSubmitted />);
    expect(screen.getByTestId('wrapup-held-reason').textContent).toBe('Held by your supervisor');
  });

  it('keeps the reason beside a running countdown after the disposition is saved', () => {
    // A non-null `ends_at`, so the bar and digits render and the reason shows only
    // if `holding` is still true. Unlike `disposition_required`, saving the
    // disposition does not end a supervisor's hold.
    const anchor = openWrapup(frame({ held_reason: 'supervisor_hold' }), 0, T0);
    render(<WrapupTimer anchor={anchor} now={T0 + 10_000} dispositionSubmitted />);
    expect(track()).not.toBeNull();
    expect(digits()).not.toBeNull();
    expect(screen.getByTestId('wrapup-held-reason').textContent).toBe('Held by your supervisor');
  });
});
