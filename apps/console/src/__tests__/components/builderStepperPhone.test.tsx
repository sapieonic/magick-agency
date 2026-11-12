import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BuilderStepper } from '../../pages/campaigns/agency/BuilderStepper';

/**
 * The New campaign stepper on a phone shows the current step's label and bare numbers for the
 * rest. Every step's item used to take an equal share of the row, so the current one was cut to
 * "Bas…" with room to spare. The current item now keeps the width its label needs.
 *
 * happy-dom applies no stylesheet and no container query, so the rule is read from the sheet.
 */

afterEach(cleanup);

/** The body of the block opened by `head`, braces balanced. */
function block(css: string, head: string): string {
  const at = css.indexOf(`${head} {`);
  if (at < 0) throw new Error(`no block ${head}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block ${head}`);
}

describe('the builder stepper on a phone', () => {
  it('marks the current step’s item, and only that one', () => {
    render(<BuilderStepper current="hours" basicsReady completed={new Set()} onSelect={() => {}} />);
    const current = screen.getByRole('button', { name: 'When to call' }).closest('li');
    expect(current?.getAttribute('data-current')).toBe('true');
    expect(screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-current'))).toHaveLength(1);
  });

  it('lets the current step’s item keep the width its label needs', () => {
    const css = readFileSync(resolve(__dirname, '../../pages/campaigns/agency/BuilderStepper.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const phone = block(css, '@container stepper (max-width: 520px)');
    const rule = block(phone, ".item[data-current='true']");
    expect(rule).toMatch(/flex:\s*0 0 auto;/);
  });
});
