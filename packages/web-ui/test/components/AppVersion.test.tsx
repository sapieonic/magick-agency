import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppVersion } from '../../src/components/AppVersion';

/**
 * The version footer both SPAs put at the foot of every sidebar. Under happy-dom no
 * stylesheet applies, so the classes are the contract: `footer` is what pins it to the
 * bottom, `compact` is the icon-rail form.
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
});
