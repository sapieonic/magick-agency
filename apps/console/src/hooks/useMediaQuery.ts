import { useEffect, useState } from 'react';

/**
 * Tracks whether a CSS media query currently matches, updating live as the viewport changes.
 * Where the environment has no `matchMedia` (jsdom, unless a test stubs it) nothing matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (hasMatchMedia() ? window.matchMedia(query).matches : false));

  useEffect(() => {
    if (!hasMatchMedia()) return undefined;
    const mql = window.matchMedia(query);
    const handleChange = () => setMatches(mql.matches);
    handleChange();
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}
