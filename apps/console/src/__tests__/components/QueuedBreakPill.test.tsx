import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { QueuedBreakPill } from '../../components/agency/QueuedBreakPill';

afterEach(cleanup);

/**
 * The queued-break pill.
 *
 * The interesting requirement is not the click — it is that **focus survives an
 * unrelated re-render**. This console re-renders whenever a frame lands, and if
 * the ✕ is re-created while it holds focus, focus silently drops to `<body>` at
 * an arbitrary moment for a reason with nothing to do with the agent.
 */

/**
 * Harness that re-renders the pill for a reason that has nothing to do with it —
 * standing in for a heartbeat or a `campaign_state` frame landing.
 */
function Harness(props: { cancelling?: boolean; cancelFailed?: boolean; onCancel?: () => void }) {
  const [frames, setFrames] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setFrames((n) => n + 1)}>
        simulate frame
      </button>
      <span data-testid="frame-count">{frames}</span>
      <QueuedBreakPill
        reasonLabel="Lunch"
        cancelling={props.cancelling ?? false}
        cancelFailed={props.cancelFailed ?? false}
        onCancel={props.onCancel ?? (() => {})}
      />
    </div>
  );
}

describe('the pill', () => {
  it('names the queued break so a deferred action is visible', () => {
    // Without it the agent presses Break, sees nothing change, and presses again.
    render(<Harness />);
    expect(screen.getByTestId('queued-break-chip').textContent).toContain(
      'Break after this call — Lunch',
    );
  });

  it('makes only the ✕ a target, not the chip', () => {
    // The chip is text the agent reads mid-call; putting a destructive action
    // under a label someone is trying to read is how you get a misclick.
    render(<Harness />);
    const chip = screen.getByTestId('queued-break-chip');
    expect(chip.tagName).not.toBe('BUTTON');
    expect(chip.getAttribute('role')).not.toBe('button');
    expect(screen.getByRole('button', { name: 'Cancel queued break' })).toBeTruthy();
  });

  it('gives the ✕ a real accessible name rather than a bare glyph', () => {
    render(<Harness />);
    const cancel = screen.getByRole('button', { name: 'Cancel queued break' });
    // The glyph itself must be hidden from the accessibility tree, or the name
    // becomes "✕ Cancel queued break".
    expect(cancel.querySelector('[aria-hidden="true"]')?.textContent).toBe('✕');
  });
});

describe('focus cannot be lost, because the loss is designed out', () => {
  /**
   * The spec allows either defence — stable identity, or capture-and-restore.
   * This component takes stable identity, and these tests assert the two facts
   * that make it hold. Both CAN fail: they fail the moment somebody re-keys the
   * pill or reaches for `disabled`.
   *
   * A restore effect was tried and deleted. It could not be honestly tested here
   * — happy-dom does not blur on disable, so the test passed with the effect
   * removed and proved nothing — and once the button is never disabled there is
   * no loss left to recover from.
   */

  it('never renders the ✕ as `disabled` — disabling a focused element blurs it', () => {
    // THE load-bearing assertion. In a real browser `disabled={cancelling}` drops
    // focus to `<body>` on the agent's own click, exactly on the path where the
    // spec requires focus to stay on the ✕. happy-dom cannot observe that blur,
    // so the property is asserted structurally instead of behaviourally.
    render(<Harness cancelling />);
    const cancel = screen.getByRole('button', { name: 'Cancel queued break' });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps the SAME DOM node across an unrelated re-render', () => {
    // Node identity is the whole defence, so it is what gets asserted — not
    // `document.activeElement`, which in this environment is preserved for free
    // and would pass even if the node were re-created.
    render(<Harness />);
    const before = screen.getByRole('button', { name: 'Cancel queued break' });

    fireEvent.click(screen.getByRole('button', { name: 'simulate frame' }));
    expect(screen.getByTestId('frame-count').textContent).toBe('1');

    expect(screen.getByRole('button', { name: 'Cancel queued break' })).toBe(before);
  });

  it('keeps the same node across many consecutive re-renders', () => {
    render(<Harness />);
    const before = screen.getByRole('button', { name: 'Cancel queued break' });
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'simulate frame' }));
    }
    expect(screen.getByRole('button', { name: 'Cancel queued break' })).toBe(before);
  });

  it('keeps the same node across the whole cancel-then-fail sequence', () => {
    // The real sequence, and the one the spec cares about: focus the ✕, press it,
    // the request is in flight, it fails. If the ✕ were conditionally rendered
    // (`{!cancelling && <button/>}`) or disabled, focus would be gone by the time
    // the agent is told to press it again.
    const { rerender } = render(
      <QueuedBreakPill reasonLabel="Lunch" cancelling={false} cancelFailed={false} onCancel={() => {}} />,
    );
    const before = screen.getByRole('button', { name: 'Cancel queued break' });
    before.focus();

    rerender(<QueuedBreakPill reasonLabel="Lunch" cancelling cancelFailed={false} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancel queued break' })).toBe(before);

    rerender(<QueuedBreakPill reasonLabel="Lunch" cancelling={false} cancelFailed onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancel queued break' })).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it('does not grab focus on mount when the agent never touched it', () => {
    render(<Harness />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('the failure path', () => {
  it('keeps the pill and its text, because the break is still queued', () => {
    // A pill that vanishes on click and reappears on a 500 teaches the agent to
    // distrust it. The truth is that the break is still queued.
    render(<Harness cancelFailed />);
    expect(screen.getByTestId('queued-break-chip').textContent).toContain(
      'Break after this call — Lunch',
    );
    expect(screen.getByText("Couldn't cancel. Try again.")).toBeTruthy();
  });

  it('renders the error BESIDE the pill, not in the rail', () => {
    // The rail is the CALL's state, and a queued break does not touch it. A
    // transient error there would break that rule for the one case where the
    // agent can least afford a distraction.
    render(<Harness cancelFailed />);
    const chip = screen.getByTestId('queued-break-chip');
    const error = screen.getByText("Couldn't cancel. Try again.");
    expect(chip.parentElement).toBe(error.parentElement);
  });

  it('shows no error line when nothing has failed', () => {
    render(<Harness />);
    expect(screen.queryByText("Couldn't cancel. Try again.")).toBeNull();
  });
});

describe('optimism is not used here', () => {
  it('marks the ✕ unavailable while in flight rather than hiding the pill', () => {
    // The pill stays until the response returns with `pending_state` absent. A
    // pill that vanishes on click and comes back on a 500 is worse than one that
    // takes 200ms to go.
    render(<Harness cancelling />);
    const cancel = screen.getByRole('button', { name: 'Cancel queued break' });
    // Marked unavailable WITHOUT `disabled`, so focus stays put (see above).
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('queued-break-chip')).toBeTruthy();
  });

  it('does not fire onCancel twice while a request is in flight', () => {
    const onCancel = vi.fn();
    render(<Harness cancelling onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued break' }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires onCancel once when enabled', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued break' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
