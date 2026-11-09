import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell wrappers must be `overflow: clip`, not only `overflow: hidden`.
 *
 * An `overflow: hidden` box is still a scroll container: `focus()` or
 * `scrollIntoView` on anything inside it that pokes past its edge scrolls it.
 * The account switcher's dropdown did exactly that: it ran off the right of the
 * screen, focused its search box, and the whole page slid left under the fixed
 * sidebar. `clip` cuts the overflow the same way but cannot be scrolled.
 *
 * happy-dom applies no stylesheet, so this reads the sheets.
 */

function ruleBody(file: string, selector: string): string {
  const css = readFileSync(resolve(__dirname, '../../components/layout', file), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  for (const block of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, sel = '', body = ''] = block;
    if (sel.replace(/\s+/g, ' ').trim() === selector) return body;
  }
  return '';
}

/** The last `overflow:` declaration wins, so that is the one that must be clip. */
function lastOverflow(body: string): string | undefined {
  return [...body.matchAll(/(?:^|[;\s])overflow:\s*([^;]+);/g)].map((m) => m[1]!.trim()).at(-1);
}

describe('shell wrappers cannot be scrolled sideways by a popover', () => {
  it.each([
    ['AgencyLayout.module.css', '.layout'],
    ['AppLayout.module.css', '.layout'],
    ['AppLayout.module.css', '.main'],
  ])('%s %s ends on overflow: clip', (file, selector) => {
    const body = ruleBody(file, selector);
    expect(body, `${selector} must exist in ${file}`).not.toBe('');
    expect(lastOverflow(body)).toBe('clip');
  });
});
