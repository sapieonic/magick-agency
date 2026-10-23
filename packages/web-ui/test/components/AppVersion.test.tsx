import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppVersion } from '../../src/components/AppVersion';

/**
 * The version both SPAs show: the footer at the foot of every sidebar, and the inline form
 * on the agent surfaces that have none. Under happy-dom no stylesheet applies, so the
 * classes are the contract: `footer` pins it to the bottom, `compact` is the icon-rail
 * form, `inline` takes the end of a row.
 */
describe('AppVersion', () => {
  it('shows the version with a v prefix, and the full version as its title', () => {
    render(<AppVersion version="0.4.2" />);
    const label = screen.getByTestId('app-version');
    expect(label.textContent).toBe('v0.4.2');
    expect(label.getAttribute('title')).toBe('Version 0.4.2');
  });

  it('is the full-width footer by default and the rail form when compact', () => {
    const { container, rerender } = render(<AppVersion version="0.4.2" />);
    const footer = container.firstElementChild as HTMLElement;
    expect(footer.className).toMatch(/footer/);
    expect(footer.className).not.toMatch(/compact/);
    rerender(<AppVersion version="0.4.2" compact />);
    expect((container.firstElementChild as HTMLElement).className).toMatch(/compact/);
  });

  it("keeps the host sidebar's own class", () => {
    const { container } = render(<AppVersion version="0.4.2" className="hostFooter" />);
    expect((container.firstElementChild as HTMLElement).className.split(' ')).toContain('hostFooter');
  });

  it('has an inline form, with no footer block, for rows of chrome without a sidebar', () => {
    const { container } = render(<AppVersion version="0.4.2" variant="inline" />);
    const host = container.firstElementChild as HTMLElement;
    expect(host.tagName).toBe('SPAN');
    expect(host.className).toMatch(/inline/);
    expect(host.className).not.toMatch(/footer/);
    expect(screen.getByTestId('app-version').textContent).toBe('v0.4.2');
  });
});
