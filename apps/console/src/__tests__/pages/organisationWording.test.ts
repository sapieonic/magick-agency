import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { appliesTo } from '../../utils/consoleNav';

/**
 * One word for the whole tenant in user copy: "organisation" (never "workspace"). The invite's
 * "All accounts (whole organisation)", the Team guide, Accounts, Email notifications and the
 * Settings hub's "Applies to" all say it. Wire values (`tenant`, `tenant_admin`) are not copy and
 * keep their names.
 */

const SRC = resolve(__dirname, '../..');
const FOLDERS = ['pages/team', 'pages/accounts', 'pages/settings'];

/** Each file's code with its comments taken out: what is left that says a word is copy. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

describe('the organisation, in so many words', () => {
  it.each(FOLDERS)('%s never says "workspace" to a reader', (folder) => {
    const dir = resolve(SRC, folder);
    const said = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => /workspace/i.test(codeOf(resolve(dir, file))));
    expect(said).toEqual([]);
  });

  it('"Applies to" names the organisation when it does not know its name', () => {
    expect(appliesTo('tenant', {})).toBe('your whole organisation');
  });
});
