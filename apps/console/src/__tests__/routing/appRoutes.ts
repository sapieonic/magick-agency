/**
 * The real route table, read from `src/App.tsx`: every `<Route>` with its nesting, and the
 * full paths they declare. The routing tests build their own tables, so only a read of
 * `App.tsx` itself tells whether a path the shell links to is routed at all.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

export interface RouteNode {
  /** Source offset of the `<Route`, i.e. declaration order. */
  at: number;
  path: string | null;
  isGate: boolean;
  parent: RouteNode | null;
}

/** `App.tsx` with comments removed, so prose about routes is not read as routes. */
export function appCode(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `<Route>` in the `<Routes>` block, with its nesting. An opening tag ends at
 * the first `>` outside braces and quotes, so JSX inside `element={…}` neither ends
 * the tag nor counts as a route; its own `path="…"` is read from the part of the
 * tag outside braces only.
 */
export function parseRoutes(code: string): RouteNode[] {
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

/** A route's full path: its ancestors' paths and its own, joined. An index route has its parent's. */
export function fullPath(node: RouteNode): string {
  const parts: string[] = [];
  for (let n: RouteNode | null = node; n; n = n.parent) if (n.path !== null) parts.unshift(n.path);
  const joined = parts.join('/').replace(/\/+/g, '/');
  return joined.startsWith('/') || joined === '*' ? joined : `/${joined}`;
}

/** Every full path `App.tsx` declares, the catch-alls (`*`) left out: they route nothing by name. */
export function declaredPaths(): string[] {
  return parseRoutes(appCode())
    .filter((r) => !r.isGate && r.path !== null && !r.path.includes('*'))
    .map(fullPath);
}

/** True when `path` (no query, no hash) is one of the declared paths, a `:param` matching one segment. */
export function isDeclared(path: string, declared: readonly string[] = declaredPaths()): boolean {
  return declared.some((d) => {
    const pattern = d.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return new RegExp(`^${pattern}$`).test(path);
  });
}
