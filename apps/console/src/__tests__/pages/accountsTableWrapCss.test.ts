import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Accounts table at phone width (QA accounts:bug:624beb080e).
 *
 * happy-dom applies no stylesheet, so this reads the sheet. `overflow-wrap: anywhere` on the name
 * made every letter a break point, so the column's narrowest width was one letter and "Default"
 * stacked a letter per line beside its Current badge. The name breaks between words only, the
 * badge wraps below it, and `.tableWrap` scrolls a table that still does not fit.
 */

const CSS_PATH = resolve(__dirname, '../../pages/accounts/AccountsPage.module.css');

function ruleBody(selector: string): string {
  const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, sel = '', body = ''] = block;
    if (sel.replace(/\s+/g, ' ').trim() === selector) return body;
  }
  return '';
}

describe('Accounts table at phone width', () => {
  it('never breaks the account name inside a word', () => {
    const name = ruleBody('.name');
    expect(name, '.name must exist').not.toBe('');
    expect(name).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(name).not.toMatch(/word-break:\s*break-all/);
  });

  it('lets the Current badge wrap below the name rather than squeezing it', () => {
    expect(ruleBody('.nameCell')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('scrolls a table that still does not fit', () => {
    expect(ruleBody('.tableWrap')).toMatch(/overflow-x:\s*auto/);
  });
});
