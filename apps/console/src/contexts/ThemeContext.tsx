import { createContext, useContext, useState, useLayoutEffect, useCallback } from 'react';
import type { ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * AS14: the console opens in light unless the user chose dark. Light is the look the agent
 * station is drawn for (a brightly lit call floor, bands read from a distance); dark stays on offer.
 *
 * **Only a choice is stored, under its own key.** The key before AS14 (`magick-agency-theme`,
 * decision B17's brand-specific name) was written on every load with whatever the default
 * then was, dark, so it cannot tell a user who chose dark from one who never chose. Reading it
 * would keep almost everyone in dark; it is left alone and no longer read. The new key is
 * written only by `toggleTheme`, so its absence means "never chose".
 */
export const THEME_CHOICE_KEY = 'magick-agency-theme-choice';

function readChoice(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_CHOICE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export function initialTheme(): Theme {
  return readChoice() ?? 'light';
}

/**
 * Puts `theme` on the document (`<html data-theme>`). web-ui's `:root` block is the dark theme, so
 * until this runs the page is dark: `main.tsx` calls it with {@link initialTheme} before the first
 * render (no dark flash on a light console), and the provider again before each paint.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Before the browser paints, never after: a passive effect would show one frame in the old theme.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_CHOICE_KEY, next);
      } catch {
        /* blocked site data: the choice lasts for this page only */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

/** The theme where a page may render without the provider (the station's tests): null then. */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext) ?? null;
}
