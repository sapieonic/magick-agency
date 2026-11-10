import { useLayoutEffect, type RefObject } from 'react';

/**
 * Nudges an absolutely positioned popover sideways so it stays on screen.
 *
 * Top-bar popovers open from their trigger's left edge, and the triggers sit at
 * the right of the bar: the account switcher is the last control, so a 280px
 * panel from its left edge runs past the viewport. Measured before paint (and
 * again on resize), the panel is shifted left by exactly its overflow, then right
 * again if that took it past the left edge, keeping `gutter` px from both edges.
 *
 * The shift is a `margin-left` set on the element, so the stylesheet's own
 * `left`/`right` (a fixed full-width phone layout, say) stay in charge and the
 * shift is simply 0 when the panel already fits. `active` re-runs the measurement
 * when the panel mounts; pass whatever opens it.
 *
 * A panel wider than the viewport minus both gutters cannot fit; cap its width in
 * CSS (`max-width: calc(100vw - 2 * gutter)`), and it is then pinned to the left
 * gutter.
 */
export function useKeepInViewport(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  gutter = 8,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;

    function place(node: HTMLElement) {
      node.style.marginLeft = '';
      const rect = node.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      let shift = 0;
      if (rect.right > viewportWidth - gutter) shift = viewportWidth - gutter - rect.right;
      if (rect.left + shift < gutter) shift = gutter - rect.left;
      node.style.marginLeft = shift === 0 ? '' : `${Math.round(shift)}px`;
    }

    place(el);
    const onResize = () => place(el);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ref, active, gutter]);
}
