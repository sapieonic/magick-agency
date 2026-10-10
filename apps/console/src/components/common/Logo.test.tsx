import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Logo } from './Logo';
import { brand } from '../../brand';

const shippedLogo = brand.logo;

afterEach(() => {
  cleanup();
  brand.logo = shippedLogo;
});

/*
 * The mark is the brand pack's logo image when it has one, and a text tile with
 * `shortName` when it does not.
 */
describe('Logo', () => {
  it('renders the shipped brand logo with brand.name as the accessible name', () => {
    expect(shippedLogo).toBe('/logo.png');
    render(<Logo />);
    const mark = screen.getByRole('img');
    expect(mark.tagName).toBe('IMG');
    expect(mark.getAttribute('src')).toBe('/logo.png');
    expect(mark.getAttribute('alt')).toBe(brand.name);
  });

  it('uses an explicit title override for the accessible name', () => {
    render(<Logo title="Custom Brand" />);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('Custom Brand');
  });

  it('renders the image square at the requested size', () => {
    render(<Logo size={64} />);
    const mark = screen.getByRole('img');
    expect(mark.getAttribute('width')).toBe('64');
    expect(mark.getAttribute('height')).toBe('64');
  });

  describe('a brand pack without a logo', () => {
    it('renders the shortName text tile instead of an image', () => {
      brand.logo = undefined;
      const { container } = render(<Logo title="Custom Brand" />);
      const mark = screen.getByRole('img');
      expect(mark.tagName).toBe('SPAN');
      expect(mark.getAttribute('aria-label')).toBe('Custom Brand');
      expect(mark.textContent).toBe(brand.shortName);
      expect(container.querySelector('img')).toBeNull();
    });

    it('renders a square tile at the requested size', () => {
      brand.logo = undefined;
      render(<Logo size={64} />);
      const mark = screen.getByRole('img');
      expect(mark.style.height).toBe('64px');
      expect(mark.style.width).toBe('64px');
    });
  });
});
