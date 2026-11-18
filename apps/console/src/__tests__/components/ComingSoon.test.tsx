import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComingSoonBadge, ComingSoonButton } from '../../components/common/ComingSoon';

/**
 * The one "Coming soon" pattern: a real button that does nothing, reachable by keyboard, whose
 * explanation is a tooltip on hover and focus and the button's description.
 */
afterEach(() => cleanup());

describe('ComingSoonButton', () => {
  it('is a focusable button marked aria-disabled, described by what it will do and that it is coming', () => {
    render(<ComingSoonButton tooltip="Give them to agents who are free now.">Give to free agents</ComingSoonButton>);
    const button = screen.getByRole('button', { name: 'Give to free agents' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    const tip = document.getElementById(button.getAttribute('aria-describedby')!)!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe('Give them to agents who are free now. Coming soon.');
    // The full button carries the visible badge too.
    expect(screen.getByTestId('coming-soon').textContent).toBe('Coming soon');
  });

  it('does nothing when pressed: no form is submitted', () => {
    const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(<form onSubmit={submit}><ComingSoonButton>Need help</ComingSoonButton></form>);
    const button = screen.getByRole('button', { name: 'Need help' });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('as a compact icon button keeps its name and explanation without a badge, and Escape hides the tooltip', () => {
    render(<ComingSoonButton compact label="Talk to Ravi" testId="talk"><svg /></ComingSoonButton>);
    const button = screen.getByRole('button', { name: 'Talk to Ravi' });
    expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toBe('Coming soon');
    expect(screen.queryByTestId('coming-soon')).toBeNull();
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.getByTestId('talk').getAttribute('data-dismissed')).toBe('true');
    fireEvent.blur(button);
    expect(screen.getByTestId('talk').hasAttribute('data-dismissed')).toBe(false);
  });

  it('the badge alone says Coming soon', () => {
    render(<ComingSoonBadge />);
    expect(screen.getByTestId('coming-soon').textContent).toBe('Coming soon');
  });
});
