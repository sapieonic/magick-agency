/**
 * The one command: `pnpm e2e [-- <playwright args>]`.
 *
 *  1. refuse unsafe targets and busy ports;
 *  2. Postgres and Redis up (`infra.ts`), a fresh migrated `magick_agency_e2e`, an empty Redis db;
 *  3. build the console and super-admin against the fake Firebase (into `.run/`, never over a
 *     developer's `dist/`; `--skip-build` reuses the last e2e build);
 *  4. the first super-admin, the simulator, the server (unchanged, plus the preload) and the edge;
 *  5. Playwright, with the list and HTML reporters (counts are printed);
 *  6. tear everything down, in reverse.
 *
 * `--stack` stops after step 4 and keeps the stack up (Ctrl-C ends it), for writing specs:
 * `pnpm --filter @magick-agency/e2e exec playwright test --ui` against it, with E2E_STACK=up.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEdge, CONSOLE_API, SUPER_ADMIN_API } from './edge.js';
import {
  E2E_ROOT, REPO_ROOT, RUN_DIR, SERVER_DIR, SUPER_ADMIN, FIREBASE_PROJECT_ID, VOICELINK,
  assertSafeTargets, databaseUrl, ports, serverEnv, uiBuildEnv, urls,
} from './env.js';
import { ensureInfra, freshDatabase, portOpen } from './infra.js';
import { Simulator } from './sim/index.js';

const log = (m: string) => console.log(`[e2e] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const argv = process.argv.slice(2).filter((a) => a !== '--');
const stackOnly = argv.includes('--stack');
const skipBuild = argv.includes('--skip-build') || process.env['E2E_SKIP_BUILD'] === '1';
const playwrightArgs = argv.filter((a) => a !== '--stack' && a !== '--skip-build');

export const UI_OUT = {
  console: join(RUN_DIR, 'console'),
  superAdmin: join(RUN_DIR, 'super-admin'),
};

function buildUis(): void {
  for (const [pkg, out] of [['@magick-agency/console', UI_OUT.console], ['@magick-agency/super-admin', UI_OUT.superAdmin]] as const) {
    log(`build: ${pkg} -> ${out}`);
    execFileSync('pnpm', ['--filter', pkg, 'exec', 'vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...uiBuildEnv() },
      stdio: 'inherit',
    });
  }
}

function createSuperAdmin(): void {
  log(`seed: super-admin ${SUPER_ADMIN.email}`);
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/create-super-admin.ts', '--email', SUPER_ADMIN.email, '--name', SUPER_ADMIN.name], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: databaseUrl(), SUPER_ADMIN_PASSWORD: SUPER_ADMIN.password, DOTENV_CONFIG_PATH: join(RUN_DIR, 'no-such.env') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function startServer(simOrigin: string, voicelinkBaseUrl: string): ChildProcess {
  const logFile = join(RUN_DIR, 'server.log');
  log(`server: starting on ${urls.server} (log: ${logFile})`);
  const out = createWriteStream(logFile);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', join(E2E_ROOT, 'src', 'server-preload.mjs'), 'src/index.ts'],
    {
      cwd: SERVER_DIR,
      // Only the PATH and HOME of the caller: nothing else from a developer's shell reaches it.
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        ...serverEnv(),
        VOICELINK_BASE_URL: voicelinkBaseUrl,
        E2E_SIM_ORIGIN: simOrigin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

async function waitReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode} before it was ready: see ${join(RUN_DIR, 'server.log')}`);
    try {
      const r = await fetch(`${urls.server}/readyz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server not ready after 120 s: see ${join(RUN_DIR, 'server.log')}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main(): Promise<number> {
  assertSafeTargets();
  mkdirSync(RUN_DIR, { recursive: true });
  for (const [name, port] of Object.entries(ports)) {
    if (await portOpen(port)) throw new Error(`port ${port} (${name}) is in use: is another e2e stack running? (E2E_${name.toUpperCase()}_PORT moves it)`);
  }

  const infra = await ensureInfra(log);
  let sim: Simulator | null = null;
  let server: ChildProcess | null = null;
  let stopEdge: (() => Promise<void>) | null = null;
  const teardown = async () => {
    log('teardown');
    if (stopEdge) await stopEdge();
    await stopChild(server);
    if (sim) await sim.stop();
    await infra.stop();
  };

  try {
    await freshDatabase(log);
    if (!skipBuild || !existsSync(join(UI_OUT.console, 'index.html')) || !existsSync(join(UI_OUT.superAdmin, 'index.html'))) buildUis();
    createSuperAdmin();

    sim = new Simulator({ port: ports.sim, projectId: FIREBASE_PROJECT_ID, voicelink: VOICELINK, serverOrigin: urls.server });
    await sim.start();
    log(`sim: ${sim.origin} (VoiceLink ${sim.voicelink.baseUrl})`);

    server = startServer(sim.origin, `${sim.voicelink.baseUrl}`);
    await waitReady(server);
    log('server: ready');

    stopEdge = await startEdge(
      [
        { port: ports.console, root: UI_OUT.console, api: CONSOLE_API },
        { port: ports.superAdmin, root: UI_OUT.superAdmin, api: SUPER_ADMIN_API },
      ],
      { host: '127.0.0.1', port: ports.server },
    );
    log(`edge: console ${urls.console}, super-admin ${urls.superAdmin}`);
    writeFileSync(join(RUN_DIR, 'stack.json'), JSON.stringify({ urls, startedAt: new Date().toISOString() }, null, 2));

    if (stackOnly) {
      log('stack is up; Ctrl-C to stop. Run specs against it with E2E_STACK=up pnpm exec playwright test');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      await teardown();
      return 0;
    }

    log(`playwright test ${playwrightArgs.join(' ')}`);
    const code = await new Promise<number>((resolve) => {
      const pw = spawn('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs], {
        cwd: E2E_ROOT,
        env: { ...process.env, E2E_STACK: 'up' },
        stdio: 'inherit',
      });
      pw.on('exit', (c) => resolve(c ?? 1));
    });
    await teardown();
    return code;
  } catch (err) {
    console.error(`[e2e] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    await teardown().catch(() => undefined);
    return 1;
  }
}

main().then((code) => process.exit(code));
