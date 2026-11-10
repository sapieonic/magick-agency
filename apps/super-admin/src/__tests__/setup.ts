import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Not `globals: true`: register only the cleanup RTL cannot register itself.
afterEach(() => cleanup());

// The reader prefers reduced motion: a StatCard's count-up (useCountUp) then shows its value at
// once, so a test reads the value the card settles on, never a frame of the animation.
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query: string) => {
  const list = matchMedia(query);
  if (query === REDUCED_MOTION) Object.defineProperty(list, 'matches', { value: true });
  return list;
};
