import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComingSoonButton } from '../../components/common/ComingSoon';

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

  it('never passes a press to a parent', () => {
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <ComingSoonButton>Join call</ComingSoonButton>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    expect(parent).not.toHaveBeenCalled();
  });

  it('keeps a press from following a link around it', () => {
    render(<a href="#elsewhere"><ComingSoonButton>Join call</ComingSoonButton></a>);
    const pressed = fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    // fireEvent returns false when the event's default action was prevented.
    expect(pressed).toBe(false);
  });

  it('hides its tooltip on Escape while only hovered, not focused (WCAG 1.4.13)', () => {
    render(<ComingSoonButton testId="join">Join call</ComingSoonButton>);
    const wrap = screen.getByTestId('join');
    fireEvent.mouseEnter(wrap);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Join call' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(wrap.getAttribute('data-dismissed')).toBe('true');
    // Shown again the next time the pointer comes back.
    fireEvent.mouseLeave(wrap);
    expect(wrap.hasAttribute('data-dismissed')).toBe(false);
    // Not hovered, an Escape elsewhere on the page is none of its business.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(wrap.hasAttribute('data-dismissed')).toBe(false);
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
});
