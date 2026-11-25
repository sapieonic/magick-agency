// Bundles the server into dist/index.js. Workspace packages (@magick-agency/*)
// are TypeScript source and are bundled in; every other import stays external
// and is resolved from apps/server/node_modules at runtime, so the server's
// package.json must declare every third-party dependency it reaches.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { assertBundled, bundledPackageVersions, WORKSPACE } from './package-versions.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The bundled workspace packages' versions, for the OTel resource and the listening line.
const packageVersions = bundledPackageVersions(pkg);

const result = await build({
  // migrate.js: the pre-boot migration step docker/entrypoint.sh runs.
  // create-super-admin.js: the first-admin CLI, runnable inside the image.
  // cleanup-service-campaign-pinned-caller-ids.js: the one-off CR9 caller-ID clean-up.
  // Named entries, so every output lands at dist/<name>.js whatever directory it is in.
  entryPoints: {
    index: 'src/index.ts',
    migrate: 'src/migrate.ts',
    'create-super-admin': 'scripts/create-super-admin.ts',
    'cleanup-service-campaign-pinned-caller-ids': 'scripts/cleanup-service-campaign-pinned-caller-ids.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  metafile: true,
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
          if (WORKSPACE.test(args.path) || args.path.startsWith('node:')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});
assertBundled(result.metafile, packageVersions);

const packages = Object.entries(packageVersions).map(([name, version]) => `${name} ${version}`).join(', ');
console.log(`built dist/index.js, dist/migrate.js, dist/create-super-admin.js, dist/cleanup-service-campaign-pinned-caller-ids.js (server ${pkg.version}; ${packages})`);
