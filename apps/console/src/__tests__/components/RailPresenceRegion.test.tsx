import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { RailPresenceRegion } from '../../components/agency/RailPresenceRegion';

/**
 * `AD-P2-U-04` — keyboard focus survives the rail's repaint (§A.13.9).
 *
 * The rail's right-hand region is rewritten four times a second to advance the
 * break elapsed time, and `End break` is the **only** control in the break state.
 * In the designer's prototype focus survived **less than 250ms, every time** — and
 * it would have shipped, because the `A` shortcut still worked: the state is fully
 * operable, so nothing looks broken unless you are navigating by focus.
 *
 * **Every focus assertion here is paired with a timer assertion**, because the
 * inadmissible "fix" is to stop the re-render — and a test that only checks focus
 * passes when someone freezes the region, trading an accessibility bug for a
 * correctness one (a five-minute break reading as four).
 */

const SINCE = '2026-08-11T12:00:00.000Z';
const T0 = Date.parse(SINCE);

function noop() {}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/**
 * Advance timers, which also advances the faked `Date` — so repaints fire against
 * a clock that has genuinely moved.
 *
 * Deliberately NOT `setSystemTime(Date.now() + ms)` as well: that moves the clock
 * a second time and every elapsed reading comes out exactly doubled. Caught
 * because these assertions name the exact expected string; a looser
 * `toBeGreaterThan(0)` would have passed and hidden it.
 */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function renderBreak(props: Partial<Parameters<typeof RailPresenceRegion>[0]> = {}) {
  return render(
    <RailPresenceRegion
      agentState="break"
      since={SINCE}
      clockOffsetMs={0}
      breakReasonLabel="Lunch"
      busy={false}
      onGoAvailable={noop}
      onEndBreak={noop}
      {...props}
    />,
  );
}

const endBreak = () => screen.getByRole('button', { name: 'End break' });
const elapsed = () => screen.getByTestId('break-elapsed').textContent;

describe('the paired property — focus held AND the timer still moving', () => {
  it('keeps focus on End break across many repaints while the clock advances', () => {
    renderBreak();
    const before = endBreak();
    before.focus();
    expect(document.activeElement).toBe(before);
    expect(elapsed()).toBe('0:00');

    // Well past the 250ms repaint the prototype could not survive.
    advance(5_000);

    // (1) The timer moved. Without this, freezing the region would pass.
    expect(elapsed()).toBe('0:05');
    // (2) Focus is on the SAME node — asserted by identity, because
    // `document.activeElement` is preserved for free when a node is not replaced,
    // so identity is the property that actually distinguishes the implementations.
    expect(endBreak()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it('holds across a full minute of repaints — roughly 240 rewrites', () => {
    renderBreak();
    const before = endBreak();
    before.focus();

    advance(60_000);

    expect(elapsed()).toBe('1:00');
    expect(endBreak()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it('advances from the SERVER anchor, so a five-minute break does not read as four', () => {
    // Anchored to `agent_state.since`, never to a local counter started at the
    // transition — that is the §A.13.4 defect this repaint exists to prevent.
    renderBreak();
    advance(300_000);
    expect(elapsed()).toBe('5:00');
  });

  it('applies the clock offset to the anchor', () => {
    // A machine 90s fast must not report a 90s-longer break.
    renderBreak({ clockOffsetMs: -90_000 });
    advance(0);
    // `since` corrected forward by 90s lands in the future, and elapsed floors at 0.
    expect(elapsed()).toBe('0:00');
    advance(95_000);
    expect(elapsed()).toBe('0:05');
  });
});

describe('the node is never replaced — mechanism (a)', () => {
  it('reuses the same button when the label changes between states', () => {
    // Rendering `offline` and `break` as two sibling branches would let React
    // unmount one and mount the other, which is exactly the loss this component
    // exists to prevent.
    const { rerender } = render(
      <RailPresenceRegion
        agentState="offline"
        since={null}
        clockOffsetMs={0}
        busy={false}
        onGoAvailable={noop}
        onEndBreak={noop}
      />,
    );
    const before = screen.getByRole('button', { name: 'Go available' });
    before.focus();

    rerender(
      <RailPresenceRegion
        agentState="break"
        since={SINCE}
        clockOffsetMs={0}
        breakReasonLabel="Lunch"
        busy={false}
        onGoAvailable={noop}
        onEndBreak={noop}
      />,
    );

    const after = screen.getByRole('button', { name: 'End break' });
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it('keeps the node across a busy transition', () => {
    const { rerender } = renderBreak();
    const before = endBreak();
    before.focus();

    rerender(
      <RailPresenceRegion
        agentState="break"
        since={SINCE}
        clockOffsetMs={0}
        breakReasonLabel="Lunch"
        busy
        onGoAvailable={noop}
        onEndBreak={noop}
      />,
    );

    expect(endBreak()).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});

describe('the node is never disabled — mechanism (b)', () => {
  it('marks busy with aria-disabled, never the disabled attribute', () => {
    // The browser blurs a focused element on disable and re-enabling does not
    // restore it, so `disabled={busy}` would drop a keyboard agent to `<body>` for
    // the whole length of the request. Structural assertion, because happy-dom
    // cannot observe the blur.
    renderBreak({ busy: true });
    const button = endBreak();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('does not fire the handler while busy', () => {
    const onEndBreak = vi.fn();
    renderBreak({ busy: true, onEndBreak });
    fireEvent.click(endBreak());
    expect(onEndBreak).not.toHaveBeenCalled();
  });

  it('fires the right handler per state when not busy', () => {
    const onEndBreak = vi.fn();
    const onGoAvailable = vi.fn();
    renderBreak({ onEndBreak, onGoAvailable });
    fireEvent.click(endBreak());
    expect(onEndBreak).toHaveBeenCalledTimes(1);
    expect(onGoAvailable).not.toHaveBeenCalled();
  });
});

describe('the control is a verb, and only where there is an action', () => {
  it('offers Go available when offline', () => {
    render(
      <RailPresenceRegion agentState="offline" since={null} clockOffsetMs={0} busy={false} onGoAvailable={noop} onEndBreak={noop} />,
    );
    expect(screen.getByRole('button', { name: 'Go available' })).toBeTruthy();
  });

  it('renders no presence button when available — Break lives in the action bar', () => {
    render(
      <RailPresenceRegion agentState="available" since={SINCE} clockOffsetMs={0} busy={false} onGoAvailable={noop} onEndBreak={noop} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['reserved', 'on_call', 'wrapup'] as const)(
    'renders no presence button during %s — Break queues instead',
    (agentState) => {
      render(
        <RailPresenceRegion agentState={agentState} since={SINCE} clockOffsetMs={0} busy={false} onGoAvailable={noop} onEndBreak={noop} />,
      );
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('is not a toggle — no checkbox or switch semantics anywhere', () => {
    // A switch forces the agent to answer "which way is on" from peripheral
    // vision, and puts state in two places. The rail holds state; the control
    // says what pressing it does.
    renderBreak();
    const button = endBreak();
    expect(button.getAttribute('role')).toBeNull();
    expect(button.getAttribute('aria-checked')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBeNull();
  });
});

describe('the elapsed time only exists on break', () => {
  it('shows no elapsed time when offline', () => {
    render(
      <RailPresenceRegion agentState="offline" since={null} clockOffsetMs={0} busy={false} onGoAvailable={noop} onEndBreak={noop} />,
    );
    expect(screen.queryByTestId('break-elapsed')).toBeNull();
  });

  it('renders an em dash rather than 0:00 when there is no anchor', () => {
    // No `since` means we cannot say how long, and inventing zero would claim a
    // break just started when it may be an hour old.
    renderBreak({ since: null });
    expect(elapsed()).toBe('—');
  });

  it('does not tick when not on break', () => {
    // The interval is gated, not the render — gating the render would change the
    // DOM shape and could itself cost focus.
    render(
      <RailPresenceRegion agentState="available" since={SINCE} clockOffsetMs={0} busy={false} onGoAvailable={noop} onEndBreak={noop} />,
    );
    advance(5_000);
    expect(screen.queryByTestId('break-elapsed')).toBeNull();
  });
});
