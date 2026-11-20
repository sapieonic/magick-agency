import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ThemeProvider, THEME_CHOICE_KEY, applyTheme, initialTheme, useTheme } from '../../contexts/ThemeContext';
import mainSource from '../../main.tsx?raw';

/** AS14: light unless the user chose dark; only a choice is stored. */

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme} data-testid="theme">
      {theme}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('ThemeProvider (AS14)', () => {
  it('opens in light when the user never chose', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores the old key, which held the old dark default whether or not anyone chose it', () => {
    localStorage.setItem('magick-agency-theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('opens in dark for a user who chose dark', () => {
    localStorage.setItem(THEME_CHOICE_KEY, 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('stores nothing until the user toggles, then stores the choice', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(localStorage.getItem(THEME_CHOICE_KEY)).toBeNull();
    act(() => screen.getByTestId('theme').click());
    expect(localStorage.getItem(THEME_CHOICE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('no dark flash on load (AS14)', () => {
  it('the provider puts the theme on the document before anything paints, not after', () => {
    // web-ui's `:root` is dark; a page left there until a passive effect ran showed a dark frame.
    document.documentElement.setAttribute('data-theme', 'dark');
    let seenByFirstEffect: string | null = null;
    function FirstEffect() {
      useEffect(() => {
        seenByFirstEffect ??= document.documentElement.getAttribute('data-theme');
      }, []);
      return null;
    }
    render(<ThemeProvider><FirstEffect /></ThemeProvider>);
    // A child's passive effect runs before its parent's: only a layout effect is in time.
    expect(seenByFirstEffect).toBe('light');
  });

  it('main.tsx applies the theme before the first render', () => {
    const applied = mainSource.indexOf('applyTheme(initialTheme())');
    expect(applied).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(mainSource.indexOf('createRoot('));
    applyTheme(initialTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
