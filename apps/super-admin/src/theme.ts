import { useCallback, useState } from 'react';

/**
 * The super-admin console's theme (AS14): light unless the operator chose dark here. The tokens
 * are web-ui's (`global.css`): its root block is the dark theme and `[data-theme='light']` the
 * light one, so the theme is the `data-theme` attribute on `<html>`.
 *
 * **Only a choice is stored**, under this app's own key (written by {@link useTheme}'s `toggle`,
 * never on load), so its absence means "never chose" and the default can change without
 * overriding anyone. Storage that throws (a private window, blocked site data) reads as no
 * choice, and a choice made then lasts for the page only.
 */
export type Theme = 'light' | 'dark';

export const SA_THEME_CHOICE_KEY = 'magick-agency-super-admin-theme-choice';

/** The operator's saved choice, or null when they never chose (or storage cannot be read). */
export function readThemeChoice(): Theme | null {
  try {
    const stored = localStorage.getItem(SA_THEME_CHOICE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

/** The theme a page opens in: the saved choice, else light. */
export function initialTheme(): Theme {
  return readThemeChoice() ?? 'light';
}

/** Put `theme` on the document (`<html data-theme>`). */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * The theme on screen and the switch between the two. `main.tsx` applies {@link initialTheme}
 * before the first render, so the login page opens in it too; this hook reads the same rule.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(SA_THEME_CHOICE_KEY, next);
      } catch {
        /* blocked site data: the choice lasts for this page only */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
