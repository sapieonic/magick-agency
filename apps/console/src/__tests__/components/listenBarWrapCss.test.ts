import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The listening bar's ended reason is read in full at every width (`docs/listening.md` §9, §12).
 *
 * "Listening stopped because your access could not be checked. Try again." sat in about 130 px
 * beside Try again and Dismiss on a 360 px phone, in a line set to one line with an ellipsis, and
 * showed as "Listening stopped b…": the one thing the bar was still there to say. happy-dom applies
 * no stylesheet, so this reads the sheet: the ended line's rule neither clips nor keeps to one
 * line, and at phone width the bar's rows wrap (`ListenBar.test.tsx` pins that the ended line
 * carries the class).
 */

const SHEET = '../../components/listen/ListenBar.module.css';

function css(): string {
  return readFileSync(resolve(__dirname, SHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the block opened by `head`, braces balanced. */
function block(source: string, head: string): string {
  const at = source.indexOf(`${head} {`);
  if (at < 0) throw new Error(`no block ${head}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced block ${head}`);
}

/** Every rule for `selector` outside any `@` block, joined. */
function screenRule(source: string, selector: string): string {
  let flat = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '@') {
      let depth = 0;
      let j = source.indexOf('{', i);
      for (; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    flat += source[i];
  }
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel = '']) => sel.split(',').map((s) => s.trim()).includes(selector))
    .map(([, , body = '']) => body)
    .join(';');
}

describe('the listening bar’s ended reason wraps', () => {
  it('the ended line neither clips nor keeps to one line', () => {
    const rule = screenRule(css(), '.endedLine');
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).not.toMatch(/text-overflow/);
    expect(rule).not.toMatch(/overflow:\s*hidden/);
  });

  it('at phone width the bar’s rows wrap rather than squeeze the line beside the buttons', () => {
    const phone = block(css(), '@media (max-width: 640px)');
    expect(phone).not.toMatch(/flex-wrap:\s*nowrap/);
    expect(screenRule(css(), '.row')).toMatch(/flex-wrap:\s*wrap/);
  });
});
