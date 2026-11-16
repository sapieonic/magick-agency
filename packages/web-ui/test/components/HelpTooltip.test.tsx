import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HelpTooltip, LabelWithHint } from '../../src/components/HelpTooltip';

/** Press the way a pointer does: pointerdown, then click. A bare click is the keyboard. */
function press(button: HTMLElement) {
  fireEvent.pointerDown(button);
  fireEvent.click(button);
}

describe('HelpTooltip', () => {
  it('stays out of the accessible name until the button opens it', () => {
    render(
      <div role="rowheader">
        Connected
        <HelpTooltip text="Leaves wrap-up redials out." />
      </div>,
    );
    const explain = screen.getByRole('button', { name: 'Explain' });
    expect(explain.getAttribute('type')).toBe('button');
    expect(screen.getByRole('rowheader', { name: 'Connected' })).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')?.getAttribute('aria-hidden')).toBe('true');

    press(explain);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Leaves wrap-up redials out.');
    expect(explain.getAttribute('aria-describedby')).toBe(tip.id);
    expect(explain.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens from the keyboard and stays open when Enter clicks it', () => {
    render(<HelpTooltip text="People answered, of first dials placed." />);
    const explain = screen.getByRole('button', { name: 'Explain' });
    fireEvent.focus(explain);
    expect(screen.getByRole('tooltip').textContent).toBe('People answered, of first dials placed.');
    fireEvent.click(explain);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(explain, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.blur(explain);
  });

  it('does not activate a control labelled by an ancestor label', () => {
    render(
      <label>
        Cap
        <HelpTooltip text="The most calls this number places at once." />
        <input type="checkbox" />
      </label>,
    );
    press(screen.getByRole('button', { name: 'Explain' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });
});

describe('LabelWithHint', () => {
  it('puts the label and the explanation on one row', () => {
    render(<LabelWithHint label="Connected (including wrap-up redials)" hint="Redials included." />);
    expect(screen.getByText('Connected (including wrap-up redials)')).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
    press(screen.getByRole('button', { name: 'Explain' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Redials included.');
  });
});
