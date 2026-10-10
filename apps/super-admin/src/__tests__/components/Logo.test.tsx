import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Logo } from '../../components/common/Logo';
import { brand } from '../../brand';

afterEach(cleanup);

describe('Logo', () => {
  it('renders the logo image with brand.name as the accessible name', () => {
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

  it('renders square at the requested size', () => {
    render(<Logo size={64} />);
    const mark = screen.getByRole('img');
    expect(mark.getAttribute('width')).toBe('64');
    expect(mark.getAttribute('height')).toBe('64');
  });
});
