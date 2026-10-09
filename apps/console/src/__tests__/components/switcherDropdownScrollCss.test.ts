import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The org/account switcher list must be the scrolling surface.
 *
 * happy-dom applies no stylesheet, so a rendering test can only see that
 * `data-testid="switcher-list"` landed — which it would even if `.list` had
 * neither `max-height` nor `overflow-y`, i.e. the exact overflow that made a
 * long tenant list unscrollable. This reads the sheet.
 *
 * Overflow belongs on `.list`, not `.dropdown`. Putting it on the panel
 * scrolls the search box away; putting it on neither is the original bug.
 */

const CSS_PATH = resolve(__dirname, '../../components/layout/SwitcherDropdown.module.css');

function rules(): string {
  return readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

function selectorsDeclaring(declaration: string): string[] {
  const found: string[] = [];
  for (const block of rules().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selector = '', body = ''] = block;
    if (body.includes(declaration)) found.push(selector.replace(/\s+/g, ' ').trim());
  }
  return found;
}

function ruleBody(selector: string): string {
  for (const block of rules().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, sel = '', body = ''] = block;
    if (sel.replace(/\s+/g, ' ').trim() === selector) return body;
  }
  return '';
}

describe('SwitcherDropdown list is the scrolling surface', () => {
  it('gives .list overflow-y: auto so a long org/account list can scroll', () => {
    expect(
      selectorsDeclaring('overflow-y: auto').some((selector) => selector === '.list'),
      '.list must set overflow-y: auto — without it the dropdown grows with every tenant and cannot scroll to an off-screen org',
    ).toBe(true);
  });

  it('caps .list against the viewport so overflow-y has a box to overflow', () => {
    const body = ruleBody('.list');
    expect(body, '.list must exist').not.toBe('');
    expect(
      /max-height:\s*min\(/.test(body) && body.includes('100vh'),
      '.list max-height must be a viewport-aware min() — a dummy max-height: 9999px would satisfy overflow-y without actually capping the list',
    ).toBe(true);
  });

  it('does not put overflow on .dropdown, which would scroll the search away', () => {
    const body = ruleBody('.dropdown');
    expect(
      !/\boverflow(?:-x|-y)?:/.test(body),
      '.dropdown must not be the scrolling surface — label and search stay put while .list scrolls',
    ).toBe(true);
  });

  it('keeps the header from shrinking so search cannot scroll away', () => {
    expect(ruleBody('.header')).toContain('flex-shrink: 0');
    expect(ruleBody('.list')).toContain('min-height: 0');
  });
});
