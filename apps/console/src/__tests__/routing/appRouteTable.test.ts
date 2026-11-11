/**
 * The real route table (`src/App.tsx`) keeps every signed-in page inside the
 * `ScopeGate` layout route and under `ScopedRouter` (B26).
 *
 * A signed-in route declared outside the gate would render unscoped: its URL would
 * name no tenant or account, a copied link would open whichever one the reader's
 * browser last had, and `ScopedRouter` would not prefix anything under it. The
 * routing tests build their own table, so only a read of `App.tsx` itself catches
 * that drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The pages that are unscoped by definition (`isUnscopedPagePath`). */
const PUBLIC_PATHS = ['/login', '/agency/login', '/agency/join/:token', '/join/:token', '/verify-email'];

/** Signed-in entry points that must sit inside the gate. */
const GATED_PATHS = [
  '/',
  '/station',
  '/dialer',
  '/dialer/performance',
  '/dialer/attempts',
  '/dialer/phone',
  '/agency',
  '/settings',
  '/app',
  '*',
];

interface RouteNode {
  /** Source offset of the `<Route`, i.e. declaration order. */
  at: number;
  path: string | null;
  isGate: boolean;
  parent: RouteNode | null;
}

/** `App.tsx` with comments removed, so prose about routes is not read as routes. */
function appCode(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `<Route>` in the `<Routes>` block, with its nesting. An opening tag ends at
 * the first `>` outside braces and quotes, so JSX inside `element={…}` neither ends
 * the tag nor counts as a route; its own `path="…"` is read from the part of the
 * tag outside braces only.
 */
function parseRoutes(code: string): RouteNode[] {
  const start = code.indexOf('<Routes>');
  const end = code.indexOf('</Routes>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = code.slice(start, end);

  const nodes: RouteNode[] = [];
  const stack: RouteNode[] = [];
  const token = /<Route\b|<\/Route>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(block))) {
    if (m[0] === '</Route>') {
      expect(stack.length).toBeGreaterThan(0);
      stack.pop();
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let topLevel = '';
    let i = m.index + m[0].length;
    let selfClosing = false;
    for (; i < block.length; i++) {
      const c = block[i]!;
      if (depth === 0 && quote) {
        topLevel += c;
        if (c === quote) quote = null;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (depth === 0 && c === '/' && block[i + 1] === '>') {
        selfClosing = true;
        i += 1;
        break;
      } else if (depth === 0 && c === '>') break;
      if (depth === 0 && c !== '}') topLevel += c;
    }
    const tag = block.slice(m.index, i + 1);
    const node: RouteNode = {
      at: m.index,
      path: /\bpath="([^"]*)"/.exec(topLevel)?.[1] ?? null,
      isGate: /^<Route\s+element=\{\s*<ScopeGate\s*\/>\s*\}\s*>$/.test(tag),
      parent: stack[stack.length - 1] ?? null,
    };
    nodes.push(node);
    if (!selfClosing) stack.push(node);
    token.lastIndex = i + 1;
  }
  expect(stack).toEqual([]);
  return nodes;
}

function insideGate(node: RouteNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.isGate) return true;
  return false;
}

describe('App.tsx route table (B26)', () => {
  const code = appCode();
  const routes = parseRoutes(code);
  const gates = routes.filter((r) => r.isGate);

  it('routes through ScopedRouter, not BrowserRouter', () => {
    expect(code).not.toMatch(/\bBrowserRouter\b/);
    const open = code.indexOf('<ScopedRouter>');
    const close = code.indexOf('</ScopedRouter>');
    expect(open).toBeGreaterThan(-1);
    expect(code.indexOf('<Routes>')).toBeGreaterThan(open);
    expect(code.indexOf('</Routes>')).toBeLessThan(close);
  });

  it('has exactly one ScopeGate layout route, at the top of the table', () => {
    expect(gates).toHaveLength(1);
    expect(gates[0]!.parent).toBeNull();
    expect(gates[0]!.path).toBeNull();
  });

  it('declares only the public pages before the gate', () => {
    const gate = gates[0]!;
    const before = routes.filter((r) => r.at < gate.at);
    // Not vacuous: the public pages really were read from the file.
    expect(before.map((r) => r.path).sort()).toEqual([...PUBLIC_PATHS].sort());
    expect(before.every((r) => r.parent === null)).toBe(true);
  });

  it('declares nothing outside the gate but the public pages', () => {
    const outside = routes.filter((r) => !r.isGate && !insideGate(r));
    expect(outside.map((r) => r.path).sort()).toEqual([...PUBLIC_PATHS].sort());
  });

  it.each(GATED_PATHS)('declares %s inside the gate', (path) => {
    const declared = routes.filter((r) => r.path === path);
    expect(declared.length).toBeGreaterThan(0);
    for (const route of declared) expect(insideGate(route)).toBe(true);
  });
});
