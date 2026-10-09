// Bundles the server into dist/index.js. Workspace packages (@magick-agency/*)
// are TypeScript source and are bundled in; every other import stays external
// and is resolved from apps/server/node_modules at runtime, so the server's
// package.json must declare every third-party dependency it reaches.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const workspace = /^@magick-agency\//;

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // packages/observability/src/version.ts reads this; see its header.
  define: { __MAGICK_AGENCY_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    {
      name: 'externalize-third-party',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (workspace.test(args.path) || args.path.startsWith('node:')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
console.log('built dist/index.js');
