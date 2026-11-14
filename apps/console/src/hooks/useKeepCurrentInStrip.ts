import { useLayoutEffect, type RefObject } from 'react';

/** The viewer asked for less motion: jump rather than glide. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keeps the current item of a sideways-scrolling strip (a tab bar, a section list on a phone)
 * in sight: when the item `selector` finds is outside the strip, the strip scrolls to centre it.
 * The strip's own scroll only, never `scrollIntoView`, which would scroll the page as well.
 * Nothing happens while the strip has room for every item.
 *
 * `current` is what changes when another item becomes current. `smooth` glides there (unless
 * the viewer prefers less motion); without it the strip jumps, for a page that has just opened.
 */
export function useKeepCurrentInStrip(
  ref: RefObject<HTMLElement | null>,
  selector: string,
  current: unknown,
  { smooth = false }: { smooth?: boolean } = {},
): void {
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip || current === null || strip.scrollWidth <= strip.clientWidth) return;
    const item = strip.querySelector<HTMLElement>(selector);
    if (!item) return;
    const stripBox = strip.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.left >= stripBox.left && box.right <= stripBox.right) return;
    const left = Math.max(0, strip.scrollLeft + box.left - stripBox.left - (stripBox.width - box.width) / 2);
    if (smooth && typeof strip.scrollTo === 'function') {
      strip.scrollTo({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      strip.scrollLeft = left;
    }
  }, [ref, selector, current, smooth]);
}
