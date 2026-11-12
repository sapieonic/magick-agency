import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The campaign data pages' header actions wrap rather than run off a phone screen.
 *
 * The Contacts header holds up to four actions (Refresh, Add contacts, Export CSV, Retry
 * these contacts). Without `flex-wrap` the last one started at x=366 of a 390px screen,
 * and scrolling it into view slid the whole main column left. happy-dom applies no
 * stylesheet, so this reads the sheets: the screen rule for each selector (outside any
 * `@media` block) must wrap, and an action button must keep its label on one line.
 */

function screenRule(file: string, selector: string): string {
  const css = readFileSync(resolve(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let flat = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '@') {
      let depth = 0;
      let j = css.indexOf('{', i);
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    flat += css[i];
  }
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel = '']) => sel.split(',').map((s) => s.trim()).includes(selector))
    .map(([, , body = '']) => body)
    .join(';');
}

describe('campaign data page actions wrap at phone width', () => {
  it.each([
    ['../../components/agency/SpineListLayout.module.css', '.actions'],
    ['../../pages/agency/AgencyCampaignContactsPage.module.css', '.actions'],
  ])('%s %s wraps', (file, selector) => {
    expect(screenRule(file, selector)).toMatch(/flex-wrap:\s*wrap/);
  });

  it('an action button keeps its label on one line', () => {
    expect(screenRule('../../components/agency/SpineListLayout.module.css', '.actionButton'))
      .toMatch(/white-space:\s*nowrap/);
  });
});
