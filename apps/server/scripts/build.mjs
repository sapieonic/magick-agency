// Bundles the server into dist/index.js. Workspace packages (@magick-agency/*)
// are TypeScript source and are bundled in; every other import stays external
// and is resolved from apps/server/node_modules at runtime, so the server's
// package.json must declare every third-party dependency it reaches.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const workspace = /^@magick-agency\//;

// The workspace packages esbuild bundles in: every @magick-agency/* the server declares
// (report-renderer is a devDependency because it is only ever bundled, never installed).
// Their versions go on the OTel resource and the listening line (packages/observability/src/version.ts).
const packageVersions = Object.fromEntries(
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => workspace.test(name))
    .sort()
    .map((name) => {
      const dep = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
      return [name.replace(workspace, ''), dep.version];
    }),
);

await build({
  // migrate.js: the pre-boot migration step docker/entrypoint.sh runs.
  // create-super-admin.js: the first-admin CLI, runnable inside the image.
  // Named entries, so every output lands at dist/<name>.js whatever directory it is in.
  entryPoints: {
    index: 'src/index.ts',
    migrate: 'src/migrate.ts',
    'create-super-admin': 'scripts/create-super-admin.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // packages/observability/src/version.ts reads these; see its header.
  define: {
    __MAGICK_AGENCY_VERSION__: JSON.stringify(pkg.version),
    __MAGICK_AGENCY_PACKAGE_VERSIONS__: JSON.stringify(packageVersions),
  },
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
console.log(`built dist/index.js, dist/migrate.js, dist/create-super-admin.js (server ${pkg.version}; ${Object.entries(packageVersions).map(([n, v]) => `${n} ${v}`).join(', ')})`);
