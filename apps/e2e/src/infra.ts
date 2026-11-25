/**
 * Postgres and Redis for an e2e run, and a fresh, migrated database.
 *
 * In order of preference: the project's own infra already up on 5436 / 6383 (`pnpm infra:up`,
 * or CI's service containers); else `docker compose` with `docker/docker-compose.dev.yml`; else
 * local `postgres` / `redis-server` binaries started under `apps/e2e/.run/` on the same ports.
 * Only what this run started is stopped at the end.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PG, REDIS, REPO_ROOT, RUN_DIR, databaseUrl } from './env.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function portOpen(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function pgReady(): Promise<boolean> {
  const c = new pg.Client({ connectionString: databaseUrl('postgres'), connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

function dockerUsable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

function pgBinDir(): string | null {
  const onPath = spawnSync('sh', ['-c', 'command -v pg_ctl'], { encoding: 'utf8' }).stdout.trim();
  if (onPath) return dirname(onPath);
  const base = '/usr/lib/postgresql';
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) if (existsSync(join(base, v, 'bin', 'pg_ctl'))) return join(base, v, 'bin');
  return null;
}

export interface Infra {
  stop(): Promise<void>;
}

/** Make sure Postgres and Redis answer on the project's ports, starting them if needed. */
export async function ensureInfra(log: (m: string) => void): Promise<Infra> {
  const stops: Array<() => Promise<void> | void> = [];
  const pgUp = await portOpen(PG.port, PG.host);
  const redisUp = await portOpen(REDIS.port, REDIS.host);

  if ((!pgUp || !redisUp) && dockerUsable()) {
    log('infra: starting Postgres and Redis with docker compose');
    execFileSync('docker', ['compose', '-f', join(REPO_ROOT, 'docker', 'docker-compose.dev.yml'), 'up', '-d', '--wait'], { stdio: 'inherit' });
  } else {
    if (!pgUp) stops.push(await startLocalPostgres(log));
    if (!redisUp) stops.push(await startLocalRedis(log));
  }
  await waitFor('Postgres', pgReady);
  await waitFor('Redis', () => portOpen(REDIS.port, REDIS.host));
  return {
    async stop() {
      for (const s of stops.reverse()) await s();
    },
  };
}

async function startLocalPostgres(log: (m: string) => void): Promise<() => void> {
  const bin = pgBinDir();
  if (!bin) throw new Error(`no Postgres on ${PG.port}, no usable docker and no local Postgres binaries: run pnpm infra:up`);
  const dataDir = join(RUN_DIR, 'pgdata');
  mkdirSync(RUN_DIR, { recursive: true });
  // Postgres refuses to run as root; run it as the `postgres` user when we are root.
  const asRoot = process.getuid?.() === 0;
  const run = (cmd: string, args: string[]) => {
    if (asRoot) {
      execFileSync('chown', ['-R', 'postgres:postgres', RUN_DIR]);
      execFileSync('su', ['postgres', '-c', [join(bin, cmd), ...args].map((a) => `'${a}'`).join(' ')], { stdio: 'inherit' });
    } else {
      execFileSync(join(bin, cmd), args, { stdio: 'inherit' });
    }
  };
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    log(`infra: initdb ${dataDir}`);
    mkdirSync(dataDir, { recursive: true });
    run('initdb', ['-D', dataDir, '-U', PG.user, '--auth=trust']);
  }
  log(`infra: starting local Postgres on ${PG.port}`);
  run('pg_ctl', ['-D', dataDir, '-o', `-p ${PG.port} -c max_connections=300 -k /tmp`, '-l', join(dataDir, 'server.log'), '-w', 'start']);
  return () => {
    try { run('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']); } catch { /* already down */ }
  };
}

async function startLocalRedis(log: (m: string) => void): Promise<() => void> {
  log(`infra: starting local redis-server on ${REDIS.port}`);
  const child: ChildProcess = spawn('redis-server', ['--port', String(REDIS.port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  child.on('error', (err) => log(`infra: redis-server failed: ${err.message}`));
  return () => { child.kill('SIGTERM'); };
}

/** Drop and recreate the e2e database, migrate it, and empty the e2e Redis db. */
export async function freshDatabase(log: (m: string) => void): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl('postgres') });
  await admin.connect();
  try {
    log(`db: recreating ${PG.database}`);
    await admin.query(`DROP DATABASE IF EXISTS ${PG.database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${PG.database}`);
  } finally {
    await admin.end();
  }
  log('db: migrating');
  // node-pg-migrate prints a line per migration (and timestamp notes on stderr): shown only on failure.
  const migrate = spawnSync('pnpm', ['--filter', '@magick-agency/db', 'run', 'migrate:up'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl() },
    encoding: 'utf8',
  });
  if (migrate.status !== 0) {
    process.stderr.write(`${migrate.stdout}\n${migrate.stderr}\n`);
    throw new Error(`migrations failed (exit ${migrate.status})`);
  }
  const redis = new Redis({ host: REDIS.host, port: REDIS.port, db: REDIS.db, lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  await redis.flushdb();
  await redis.quit();
}
