import { transform } from 'esbuild';

/**
 * Vite 8 (used by vitest >= 4.1) transforms TypeScript with Oxc instead of
 * esbuild. Oxc does not down-level TC39 *standard* decorators, so a test that
 * imports a `@Traced` source module fails at collection with a SyntaxError.
 * esbuild does down-level them given an explicit target, so the handful of
 * files that use a decorator are pre-transformed here. The production build is
 * esbuild too, so it handles them natively.
 */
/**
 * Structural stand-in for Vite's `Plugin`, so this file needs no direct `vite`
 * dependency (pnpm does not hoist vitest's copy to the workspace root).
 */
export interface DecoratorTransformPlugin {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): Promise<{ code: string; map: string } | null>;
}

const DECORATOR_RE = /(?:^|\n)[ \t]*@[A-Za-z_$]/;

export function decoratorTransform(): DecoratorTransformPlugin {
  return {
    name: 'magick-agency:esbuild-decorator-transform',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (file.startsWith('\0') || file.includes('/node_modules/')) return null;
      if (!/\.tsx?$/.test(file)) return null;
      if (!DECORATOR_RE.test(code)) return null;
      const result = await transform(code, {
        loader: file.endsWith('x') ? 'tsx' : 'ts',
        target: 'es2022',
        sourcemap: true,
        sourcefile: id,
      });
      return { code: result.code, map: result.map };
    },
  };
}
