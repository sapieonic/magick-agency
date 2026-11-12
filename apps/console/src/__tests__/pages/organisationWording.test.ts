import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { appliesTo } from '../../utils/consoleNav';

/**
 * One word for the whole tenant in user copy: "organisation", never "workspace" or "tenant".
 * The invite's "All accounts (whole organisation)", the Team guide, Accounts, the switcher, the
 * scope gate, the Do Not Call list and the invite claim all say it. Wire values (`tenant`,
 * `tenant_admin`, the `'workspace'` join door, `workspace_invite_*` events) are not copy and keep
 * their names.
 *
 * Copy is read from the source the way a reader meets it: JSX text, any string or template piece
 * with a space in it (identifiers and wire values have none), and a one-word string given to a
 * prop or field that is shown (`label`, `title`, `placeholder`, ...). Comments are not parsed as
 * strings, so they may say whatever helps the next engineer.
 */

const SRC = resolve(__dirname, '../..');
const SAYS_IT = /\b(workspace|tenant)s?\b/i;
const SHOWN_FIELD = /label|title|placeholder|noun|eyebrow|heading|text|desc|message|body|alt|tooltip/i;

/** Strings that say the word on purpose, with the reason. */
const ALLOWED = new Map<string, string>([
  // A search keyword for the agent's dialler page, never shown: people who call it that still find it.
  ['agent workspace', 'consoleSearch keyword'],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .filter((file) => !/(^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => resolve(dir, file));
}

function shownField(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return SHOWN_FIELD.test(parent.name.getText());
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return SHOWN_FIELD.test(parent.name.getText());
  return false;
}

/** Every piece of copy in `text` (a .ts or .tsx file) that names the tenant the old way. */
function copySayingIt(fileName: string, text: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let copy: string | null = null;
    if (node.kind === ts.SyntaxKind.JsxText) {
      copy = node.getText(file);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      if (/\s/.test(node.text.trim()) || shownField(node)) copy = node.text;
    }
    if (copy !== null) {
      const said = copy.replace(/\s+/g, ' ').trim();
      if (SAYS_IT.test(said) && !ALLOWED.has(said)) found.push(said);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the organisation, in so many words', () => {
  it('no console copy says "workspace" or "tenant" to a reader', () => {
    const said = sourceFiles(SRC).flatMap((path) =>
      copySayingIt(path, readFileSync(path, 'utf8')).map((copy) => `${path.slice(SRC.length + 1)}: ${copy}`),
    );
    expect(said).toEqual([]);
  });

  it('reads copy, not identifiers or comments', () => {
    const sample = [
      "// the workspace's floor",
      "const door: JoinDoor = 'workspace';",
      "track('workspace_invite_viewed', {});",
      "const url = `/tenants/${id}/members`;",
      "const a = { scope: 'tenant' };",
      "const b = { label: 'Tenants' };",
      "const c = 'Your workspace opens';",
      'const d = <p title="Switch tenant">This workspace</p>;',
    ].join('\n');
    expect(copySayingIt('sample.tsx', sample)).toEqual(['Tenants', 'Your workspace opens', 'Switch tenant', 'This workspace']);
  });

  it('"Applies to" names the organisation when it does not know its name', () => {
    expect(appliesTo('tenant', {})).toBe('your whole organisation');
  });
});
