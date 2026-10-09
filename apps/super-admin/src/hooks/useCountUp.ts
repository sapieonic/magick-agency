import { useState, useEffect, useRef } from 'react';

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animate a numeric display value from 0 to the target on mount.
 * Handles formatted strings like "1,234", "85.2%", "2m 34s", "—".
 */
export function useCountUp(displayValue: string | number, duration = 800): string {
  const target = String(displayValue);
  const [current, setCurrent] = useState(target);
  const hasAnimated = useRef(false);

  useEffect(() => {
    // Don't re-animate if already done, or if reduced motion preferred
    if (hasAnimated.current || prefersReducedMotion()) {
      setCurrent(target);
      return;
    }

    // Extract the first numeric portion from the display string
    const match = target.match(/^([^0-9]*?)([\d,]+\.?\d*)(.*)/);
    if (!match) {
      // Non-numeric value (like "—"), just set it
      setCurrent(target);
      hasAnimated.current = true;
      return;
    }

    const prefix = match[1] ?? '';
    const numStr = match[2] ?? '0';
    const suffix = match[3] ?? '';
    const endNum = parseFloat(numStr.replace(/,/g, ''));
    const hasCommas = numStr.includes(',');
    const decimalPlaces = numStr.includes('.') ? (numStr.split('.')[1]?.length ?? 0) : 0;

    if (endNum === 0) {
      setCurrent(target);
      hasAnimated.current = true;
      return;
    }

    let startTime: number | null = null;
    let rafId: number;

    function formatNum(n: number): string {
      let formatted = decimalPlaces > 0 ? n.toFixed(decimalPlaces) : Math.round(n).toString();
      if (hasCommas) {
        const parts = formatted.split('.');
        parts[0] = (parts[0] ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        formatted = parts.join('.');
      }
      return formatted;
    }

    function animate(timestamp: number) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      const currentNum = easedProgress * endNum;

      setCurrent(`${prefix}${formatNum(currentNum)}${suffix}`);

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        setCurrent(target);
        hasAnimated.current = true;
      }
    }

    rafId = requestAnimationFrame(animate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [target, duration]);

  return current;
}
