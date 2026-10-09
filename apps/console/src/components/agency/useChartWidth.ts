import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The plot's width in REAL CSS pixels, so an SVG can be drawn at 1:1.
 *
 * ── Why a fixed `viewBox` is wrong on this surface ─────────────────────────
 * `AgentBucketChart` draws into a fixed `viewBox` and lets the browser scale it
 * to the container, and says why: the chart scales as one piece rather than
 * reflowing, so nothing has to be re-derived on resize at this data size. That
 * is a good trade on `/dialer/performance`, whose plot is a few hundred pixels
 * wide inside a shell.
 *
 * It breaks on the campaign workspace, which is `max-width: 2400px` and centred
 * and gives a chart the full width of it. **A scaled `viewBox` scales its TYPE
 * too.** At 2400px a 720-unit viewBox is scaled 3.3×, so `font-size: 12` axis
 * labels land on screen at forty pixels — three times the size of the card
 * heading directly above them, on the least important text in the component.
 * Bar radii, stroke widths and the 2px surface gap between a bar pair are all
 * multiplied by the same factor, so the mark specs stop being the mark specs.
 *
 * Measuring instead makes one SVG unit one CSS pixel at every width, which is
 * the only arrangement in which the type and the geometry mean what they say.
 *
 * ── The fallback is not a detail ───────────────────────────────────────────
 * happy-dom performs no layout, so `clientWidth` is `0` under test and
 * `ResizeObserver` may not exist at all. A chart that rendered nothing until it
 * had been measured would be a chart with no test coverage of its marks — so an
 * unmeasured chart draws at {@link fallback} and every assertion about its
 * geometry is against a known width. The same path serves the first paint in a
 * real browser, one frame before the observer fires.
 */
export function useChartWidth(fallback: number): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => () => observer.current?.disconnect(), []);

  /*
    A callback ref rather than `useRef` + an effect: the node has to be measured
    the moment it exists, and an effect that reads a ref runs after a paint the
    reader can see. This way the first measured render is the first one with a
    non-fallback width.
  */
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const measure = () => {
      // Never 0: an unlaid-out node (a hidden tab, a test) keeps the fallback
      // rather than collapsing the plot to nothing and dividing by it.
      const next = Math.round(node.clientWidth);
      setWidth(next > 0 ? next : fallback);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, [fallback]);

  return [ref, width];
}
