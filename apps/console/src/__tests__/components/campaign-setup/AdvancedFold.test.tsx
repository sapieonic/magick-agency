import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AdvancedFold } from '../../../components/campaign-setup';

/** The folded Advanced section (CS13), controlled or not. */

const SUMMARY = 'Advanced settings (most campaigns don’t need these)';

function details(): HTMLDetailsElement {
  return screen.getByTestId('fold') as HTMLDetailsElement;
}

describe('AdvancedFold', () => {
  it('starts folded and opens on its own when uncontrolled', () => {
    const onToggle = vi.fn();
    render(
      <AdvancedFold summary={SUMMARY} onToggle={onToggle} testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(false);
    fireEvent.click(screen.getByText(SUMMARY));
    expect(details().open).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('honours defaultOpen', () => {
    render(
      <AdvancedFold summary={SUMMARY} defaultOpen testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(true);
  });

  it('stays open while the parent holds it open, and reports the request to fold', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AdvancedFold summary={SUMMARY} open onToggle={onToggle} testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(true);
    fireEvent.click(screen.getByText(SUMMARY));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(details().open).toBe(true);

    rerender(
      <AdvancedFold summary={SUMMARY} open={false} onToggle={onToggle} testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(false);
  });

  it('opens when the parent forces it open', () => {
    const { rerender } = render(
      <AdvancedFold summary={SUMMARY} open={false} testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(false);
    rerender(
      <AdvancedFold summary={SUMMARY} open testId="fold">
        <p>Abandonment limit</p>
      </AdvancedFold>,
    );
    expect(details().open).toBe(true);
  });
});
