import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Logo } from './Logo';
import { brand } from '../../brand';

afterEach(cleanup);

/*
 * PORT NOTE (magick-agency, decision B17): the mark is a text tile, not the
 * parent product's `/logo.png`. Same three cases, re-pointed at the tile.
 */
describe('Logo', () => {
  it('renders the brand wordmark tile with brand.name as the accessible name', () => {
    const { container } = render(<Logo />);
    const mark = screen.getByRole('img');
    expect(mark.getAttribute('aria-label')).toBe(brand.name);
    expect(mark.textContent).toBe(brand.shortName);
    // No image asset at all: the old one was the parent product's artwork.
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses an explicit title override for the accessible name', () => {
    render(<Logo title="Custom Brand" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Custom Brand');
  });

  it('renders a square tile at the requested size', () => {
    render(<Logo size={64} />);
    const mark = screen.getByRole('img');
    expect(mark.style.height).toBe('64px');
    expect(mark.style.width).toBe('64px');
  });
});
