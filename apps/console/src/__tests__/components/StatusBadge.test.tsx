import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBadge } from '../../components/common/StatusBadge';

describe('StatusBadge', () => {
  it('renders the label text', () => {
    render(<StatusBadge label="completed" />);
    expect(screen.getByText('completed')).toBeDefined();
  });

  it('renders status icon for known statuses', () => {
    const { container } = render(<StatusBadge label="completed" />);
    const icon = container.querySelector('[class*="statusIcon"]');
    expect(icon).not.toBeNull();
    // Icon should be aria-hidden
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders icon alongside label for "failed" status', () => {
    const { container } = render(<StatusBadge label="failed" />);
    const icon = container.querySelector('[class*="statusIcon"]');
    expect(icon).not.toBeNull();
    // Badge should still contain the label text
    expect(screen.getByText('failed')).toBeDefined();
  });

  it('renders icon for status with underscores', () => {
    const { container } = render(<StatusBadge label="no_answer" />);
    const icon = container.querySelector('[class*="statusIcon"]');
    expect(icon).not.toBeNull();
  });

  it('renders icon for status with spaces', () => {
    const { container } = render(<StatusBadge label="in progress" />);
    const icon = container.querySelector('[class*="statusIcon"]');
    expect(icon).not.toBeNull();
  });

  it('renders tooltip on hover for known status', () => {
    const { container } = render(<StatusBadge label="completed" />);
    const wrapper = container.querySelector('[class*="wrapper"]');
    expect(wrapper).not.toBeNull();

    // Trigger hover
    fireEvent.mouseEnter(wrapper!);
    const tooltip = container.querySelector('[class*="tooltipVisible"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toBe('Successfully finished');
  });

  it('hides tooltip on mouse leave', () => {
    const { container } = render(<StatusBadge label="completed" />);
    const wrapper = container.querySelector('[class*="wrapper"]');

    fireEvent.mouseEnter(wrapper!);
    let tooltip = container.querySelector('[class*="tooltipVisible"]');
    expect(tooltip).not.toBeNull();

    fireEvent.mouseLeave(wrapper!);
    tooltip = container.querySelector('[class*="tooltipVisible"]');
    expect(tooltip).toBeNull();
  });

  it('renders custom tooltip when provided', () => {
    const { container } = render(
      <StatusBadge label="custom" tooltip="My custom tooltip" />
    );
    const wrapper = container.querySelector('[class*="wrapper"]');
    fireEvent.mouseEnter(wrapper!);
    const tooltip = container.querySelector('[class*="tooltipVisible"]');
    expect(tooltip?.textContent).toBe('My custom tooltip');
  });

  it('does not render tooltip wrapper for unknown status without tooltip', () => {
    const { container } = render(<StatusBadge label="xyz_unknown_status" />);
    const wrapper = container.querySelector('[class*="wrapper"]');
    // No wrapper = no tooltip behavior, just a plain badge
    expect(wrapper).toBeNull();
  });

  it('renders different icons for different statuses', () => {
    const { container: c1 } = render(<StatusBadge label="queued" />);
    const { container: c2 } = render(<StatusBadge label="completed" />);

    const icon1 = c1.querySelector('[class*="statusIcon"] svg');
    const icon2 = c2.querySelector('[class*="statusIcon"] svg');

    expect(icon1).not.toBeNull();
    expect(icon2).not.toBeNull();
    // They should be different SVGs (different icon components)
    // Check by comparing the SVG content
    expect(icon1?.innerHTML).not.toBe(icon2?.innerHTML);
  });

  it('applies custom color via style', () => {
    const { container } = render(
      <StatusBadge label="completed" color="#3fcf9e" />
    );
    const badge = container.querySelector('[class*="badge"]');
    expect(badge).not.toBeNull();
    const style = badge?.getAttribute('style') ?? '';
    expect(style).toContain('#3fcf9e');
  });

  it('derives its tint and border from a CSS-variable colour, not from the accent', () => {
    // Regression: a `var(` branch used to swap in `--accent-subtle` and a violet
    // border, so a token-coloured badge rendered a green label in a purple pill.
    const { container } = render(
      <StatusBadge label="test" color="var(--success)" />
    );
    const badge = container.querySelector('[class*="badge"]');
    const style = badge?.getAttribute('style') ?? '';
    expect(style).toContain('var(--success)');
    // Only the NEGATIVE half is observable. happy-dom drops `color-mix()` from
    // the style attribute as unrecognised, so the tint and border it now sets
    // cannot be asserted from here at all — but the values it used to set can:
    // `var(--accent-subtle)` and a literal violet were plain enough to survive,
    // which is exactly why their absence is a real guard rather than a vacuous
    // one.
    expect(style).not.toContain('--accent-subtle');
    expect(style).not.toContain('124, 92, 252');
  });

  it('renders icons for all common statuses', () => {
    const statuses = [
      'completed', 'failed', 'no_answer', 'busy', 'switched_off',
      'queued', 'ringing', 'in_progress', 'scheduled', 'executing',
      'active', 'paused', 'pending', 'sent', 'delivered', 'read',
    ];

    for (const status of statuses) {
      const { container, unmount } = render(<StatusBadge label={status} />);
      const icon = container.querySelector('[class*="statusIcon"]');
      expect(icon, `Expected icon for status: ${status}`).not.toBeNull();
      unmount();
    }
  });

  // Regression: WebRTC call records use the single-L US spelling 'canceled'.
  // The icon/tooltip maps key on both spellings; without the 'canceled' alias a
  // canceled dialer call would render with no icon and no tooltip (a11y gap).
  it('renders an icon and tooltip for the single-L "canceled" spelling', () => {
    const { container, unmount } = render(<StatusBadge label="canceled" />);
    expect(container.querySelector('[class*="statusIcon"]')).not.toBeNull();
    expect(screen.getByText('Was manually cancelled before completion')).toBeTruthy();
    unmount();
  });

  it('still renders an icon and tooltip for the double-L "cancelled" spelling', () => {
    const { container, unmount } = render(<StatusBadge label="cancelled" />);
    expect(container.querySelector('[class*="statusIcon"]')).not.toBeNull();
    expect(screen.getByText('Was manually cancelled before completion')).toBeTruthy();
    unmount();
  });
});
