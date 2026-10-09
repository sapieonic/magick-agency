import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LiveDot } from '../../components/common/LiveDot';

/**
 * The pulse class is the whole contract. Under happy-dom no stylesheet is
 * applied, so nothing here can observe the animation itself — but the class is
 * what gates it, and "pulses on something that has stopped" is the bug this
 * primitive was written to end. Pinning the class is the closest a test here can
 * get to pinning that.
 */
describe('LiveDot', () => {
  const dot = (container: HTMLElement) =>
    container.querySelector('[class*="liveDot"]') as HTMLElement;

  it('pulses when live', () => {
    const { container } = render(<LiveDot live />);
    expect(dot(container).className).toMatch(/pulsing/);
  });

  it('renders but does not pulse when not live', () => {
    const { container } = render(<LiveDot live={false} />);
    const el = dot(container);
    expect(el).not.toBeNull();
    expect(el.className).not.toMatch(/pulsing/);
  });

  it('is decorative — the surrounding label carries the meaning', () => {
    const { container } = render(<LiveDot live />);
    expect(dot(container).getAttribute('aria-hidden')).toBe('true');
    expect(dot(container).getAttribute('aria-label')).toBeNull();
  });

  it('sizes to the type beside it', () => {
    const { container } = render(<LiveDot live size={6} />);
    expect(dot(container).style.width).toBe('6px');
    expect(dot(container).style.height).toBe('6px');
  });

  it('leaves the module ember default in force unless a colour is passed', () => {
    // Not `color: 'var(--ember)'` — resolving the default here would be a second
    // place the ember rule lives, and the two would drift.
    const { container } = render(<LiveDot live />);
    expect(dot(container).style.color).toBe('');
  });

  it('takes a caller colour, so a pill whose hue is its state keeps it', () => {
    const { container } = render(<LiveDot live color="currentColor" />);
    expect(dot(container).style.color).toBe('currentcolor');
  });
});

/**
 * The one rule here that no rendering test can reach.
 *
 * `global.css` kills every animation under reduced motion, which is normally why
 * a per-file `prefers-reduced-motion` block is redundant — and that general
 * guidance is exactly what would get this block deleted. It must not be: ember
 * and `--warning` are 25deg apart and the palette's stated separator is that
 * ember MOVES, so with motion gone a live dot is an orange warning dot unless
 * the halo is held as a static ring. happy-dom applies no stylesheet, so this is
 * a source-level check in the manner of `hiddenPanelCss.test.ts`.
 */
describe('LiveDot under reduced motion', () => {
  const css = readFileSync(
    resolve(__dirname, '../../components/common/LiveDot.module.css'),
    'utf8',
  );

  it('keeps the halo as a static ring rather than letting it vanish', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).not.toBe('');
    // A ring: bordered and unfilled. Filled, it reads as a bigger dot.
    expect(block).toMatch(/\.pulsing::after\s*\{[^}]*border:[^}]*\}/s);
    expect(block).toMatch(/\.pulsing::after\s*\{[^}]*background:\s*transparent/s);
    // Beating the global `!important` kill-switch is what stops the ring being
    // run to its faded-out end state.
    expect(block).toMatch(/animation:\s*none\s*!important/);
  });
});
