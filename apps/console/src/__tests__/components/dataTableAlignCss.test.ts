import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `Column<T>.align` has to win a cascade, and no test in this suite can see it.
 *
 * happy-dom applies no stylesheet, so a rendering test can only assert that the
 * class landed on the cell — which it did, throughout the bug this guards. The
 * table's own `.table th` / `.table td` rules set `text-align: left` at (0,1,1)
 * specificity, so a bare `.alignRight` class at (0,1,0) loses outright and the
 * column renders left-aligned with the right class on it.
 *
 * How it broke: an explanatory comment was written BETWEEN the selector's last
 * element and its class —
 *
 *     .table th.alignRight,
 *     .table td/❋ …why margin-left ❋/
 *     .alignRight .skeletonCell { margin-left: auto }
 *
 * CSS discards a comment at the tokenizer rather than treating it as
 * whitespace, so that is `.table td.alignRight .skeletonCell` — a rule about
 * skeletons — and the `text-align: right` it was supposed to carry had been
 * moved out to a bare `.alignRight` rule that could never apply. Center was
 * written correctly and worked, which is why the pair looked fine side by side.
 *
 * So this reads the stylesheet and requires each alignment to be declared on
 * the `.table th` / `.table td` compound. Strip comments first: otherwise the
 * guard can be satisfied by a rule that is commented out, and it can also match
 * its own prose.
 */

const CSS_PATH = resolve(__dirname, '../../components/common/DataTable.module.css');

/** The sheet with comments removed, so no assertion can be met by prose. */
function rules(): string {
  return readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every selector that carries the given declaration, comments stripped. */
function selectorsDeclaring(declaration: string): string[] {
  const found: string[] = [];
  for (const block of rules().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selector = '', body = ''] = block;
    if (body.includes(declaration)) found.push(selector.replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('DataTable alignment must beat the table cell defaults', () => {
  it("still sets text-align on the cells, or `align` is a class that does nothing", () => {
    // The premise. If these ever stop being (0,1,1) the compound below is no
    // longer needed — and this test should be deleted rather than weakened.
    const left = selectorsDeclaring('text-align: left');
    expect(
      left.some((selector) => selector.includes('.table th') || selector.includes('.table td')),
      'the table no longer sets a default text-align on its cells; re-derive what `align` has to beat',
    ).toBe(true);
  });

  for (const [value, className] of [
    ['right', 'alignRight'],
    ['center', 'alignCenter'],
  ] as const) {
    it(`declares text-align: ${value} on the .table th/.table td compound`, () => {
      const selectors = selectorsDeclaring(`text-align: ${value}`);

      expect(
        selectors.some((selector) => selector.includes(`.table th.${className}`)),
        `align: '${value}' must be declared on \`.table th.${className}\`. A bare `
          + `\`.${className}\` rule is (0,1,0) and loses to \`.table th\`'s text-align, so the `
          + 'header renders left-aligned with the class correctly applied — which no test using '
          + 'happy-dom can observe.',
      ).toBe(true);

      expect(
        selectors.some((selector) => selector.includes(`.table td.${className}`)),
        `align: '${value}' must be declared on \`.table td.${className}\` — with the class ON the `
          + `cell, not as a descendant. \`.table td .${className}\` matches a wrapper inside the `
          + 'cell and never the cell itself.',
      ).toBe(true);
    });
  }

  it('does not declare an alignment only on a bare class', () => {
    /*
      The failure mode restated as a rule: a bare `.alignRight { text-align }`
      is the shape that reads as correct, compiles, keeps every unit test green
      and renders the wrong thing.
    */
    for (const declaration of ['text-align: right', 'text-align: center']) {
      const selectors = selectorsDeclaring(declaration);
      const bare = selectors.filter((selector) => /^\.align(Right|Center)$/.test(selector));
      expect(
        bare,
        `\`${declaration}\` is declared on a bare class (${bare.join(', ')}), which cannot beat `
          + '`.table td`. Move it into the `.table th`/`.table td` compound.',
      ).toEqual([]);
    }
  });

  it('pushes the loading skeleton over with a margin, since text-align cannot move it', () => {
    // A percentage-width block ignores the cell's text-align, so a right column
    // loaded left-aligned and jumped once the rows arrived.
    const selectors = selectorsDeclaring('margin-left: auto');
    expect(
      selectors.some((selector) => selector.includes('.alignRight') && selector.includes('.skeletonCell')),
      'the skeleton bar in a right-aligned cell needs `margin-left: auto`',
    ).toBe(true);
  });
});
