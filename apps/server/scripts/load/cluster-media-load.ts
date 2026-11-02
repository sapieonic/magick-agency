/**
 * Multi-process media load (`docs/scaling.md` §9, build step 8): N calls bridged through
 * the REAL server (the image's entry under tsx, with `MEDIA_WORKERS` set or not), with
 * audio at 50 frames a second each way for every call, and every process's event-loop use
 * and CPU reported per second over a steady window.
 *
 *   pnpm tsx scripts/load/cluster-media-load.ts --calls 200 --media-workers 2 --seconds 20
 *   pnpm tsx scripts/load/cluster-media-load.ts --calls 500 --media-workers 0   # one process
 *
 * Runs on the worktree's TEST database and Redis db (`.test-env.local.json`), which it
 * truncates and flushes: never alongside an integration run. Nothing in the call path is
 * faked: pacing dials every agent, the carrier (the mock VoiceLink carrier, in its own
 * process) answers and streams, the station sockets (real upgrades, `media=alaw8`, in
 * `--floor-procs` processes of their own) talk back. Agents and contacts are seeded the way
 * the full-stack suite seeds them.
 *
 * Reported per server process: event-loop utilisation and p99 delay (from
 * `/readyz?detail=1`; the primary's own included) and CPU% (from `/proc`, every process,
 * one-process mode too); per load-generator process: CPU%. The absolute numbers are this
 * machine's: read them as ratios between runs on the same machine.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEST_DB_URL } from '../../../../packages/db/test/helpers/test-db.js';
import { TEST_REDIS_URL } from '../../test/helpers/test-redis.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const CALLS = arg('calls', 200);
const MEDIA_WORKERS = arg('media-workers', 2);
const SECONDS = arg('seconds', 20);
const FLOOR_PROCS = arg('floor-procs', 2);
const TENANT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a000001';
const ACCOUNT = '8b1d0c8e-3d0e-4c7a-8b44-1f6b0a000002';

process.env['DATABASE_URL'] = TEST_DB_URL;
process.env['REDIS_URL'] = TEST_REDIS_URL;
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'error';

const CLK_TCK = 100;
function cpuTicks(pid: number): number | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return Number(fields[11]) + Number(fields[12]); // utime + stime
  } catch {
    return null;
  }
}
function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function message<T>(child: ChildProcess, key: string): Promise<T> {
  return new Promise((r) => {
    const on = (m: Record<string, unknown>): void => { if (key in m) { child.off('message', on); r(m[key] as T); } };
    child.on('message', on);
  });
}

async function main(): Promise<void> {
  const { closePool, initDbPool } = await import('@magick-agency/db');
  const { getTestPool, truncateAll, closeTestPool } = await import('../../../../packages/db/test/helpers/test-db.js');
  const { flushTestRedis } = await import('../../test/helpers/test-redis.js');
  const { insertAgencyCampaign, insertAgencyContact } = await import('../../test/integration/agency/agency-factories.js');
  const { startClusterServer } = await import('../../test/helpers/cluster-server.js');
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

  await truncateAll();
  await flushTestRedis();
  await getTestPool().query(
    'INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls) VALUES ($1, $2, $3)', [TENANT, ACCOUNT, 100_000]);
  const campaign = await insertAgencyCampaign({
    tenant_id: TENANT, account_id: ACCOUNT, status: 'running', wrapup_seconds: 0, disposition_catalog: JSON.stringify([]),
  });
  for (let i = 0; i < CALLS; i++) {
    await insertAgencyContact(campaign.id as string, {
      tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+9195${String(10_000_000 + i).padStart(8, '0')}`, source_row_number: i + 1,
    });
  }

  const here = __dirname;
  const tsx = ['--import', 'tsx'];
  // Calls outlive the window: joining, ramp, the window, and a margin.
  const carrier = fork(resolve(here, 'load-carrier-child.ts'), [], {
    execArgv: tsx, env: { ...process.env, LOAD_CARRIER_FRAMES: String((SECONDS + 120 + CALLS / 5) * 50) },
  });
  const vl = await message<string>(carrier, 'baseUrl');
  const server = await startClusterServer({
    MEDIA_WORKERS: String(MEDIA_WORKERS),
    FF_AGENCY_DIALER: 'true',
    TELEPHONY_ENABLED_PROVIDERS: 'voicelink',
    VOICELINK_BASE_URL: vl,
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '10000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '10000000',
    RATE_LIMIT_STATION_MAX: '10000000',
    DB_POOL_MAX: '40',
  });
  carrier.send({ origin: server.origin });
  const children: ChildProcess[] = [carrier];
  cleanup = () => {
    try { server.child.kill('SIGKILL'); } catch { /* gone */ }
    for (const pid of childPids(server.child.pid!)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  };

  const floors: ChildProcess[] = [];
  for (let i = 0; i < FLOOR_PROCS; i++) {
    const f = fork(resolve(here, 'load-floor-child.ts'), [], { execArgv: tsx, env: { ...process.env, LOAD_ORIGIN: server.origin } });
    await message(f, 'up');
    floors.push(f);
    children.push(f);
  }
  const userIds = Array.from({ length: CALLS }, (_, i) => `8b1d0c8e-3d0e-4c7a-8b44-${String(i).padStart(12, '0')}`);
  const started = Date.now();
  await Promise.all(floors.map((f, i) => {
    f.send({ join: { tenantId: TENANT, accountId: ACCOUNT, campaignId: campaign.id, userIds: userIds.filter((_, j) => j % FLOOR_PROCS === i) } });
    return message(f, 'joined');
  }));
  const joinedMs = Date.now() - started;

  // Wait until every call is bridged (pacing dials every available agent). A server that
  // cannot get there (a saturated loop) is measured with what it bridged, and says so.
  const bridged = async (): Promise<number> => (await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE bridged_at IS NOT NULL AND state <> 'ended'`)).rows[0]!.n;
  const deadline = Date.now() + 180_000;
  let plateau = { n: -1, since: Date.now() };
  for (;;) {
    const n = await bridged();
    if (n >= CALLS) break;
    if (n !== plateau.n) plateau = { n, since: Date.now() };
    // No progress for 30 s, or out of time: measure what is there.
    if (Date.now() > deadline || Date.now() - plateau.since > 30_000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const bridgedMs = Date.now() - started;
  const bridgedAtStart = await bridged();
  await new Promise((r) => setTimeout(r, 3_000)); // settle

  const stats = async (): Promise<{ heard: number; mediaIn: number }> => {
    const heardParts = await Promise.all(floors.map((f) => { f.send({ stats: true }); return message<{ heard: number }>(f, 'stats'); }));
    carrier.send({ stats: true });
    const c = await message<{ mediaIn: number }>(carrier, 'stats');
    return { heard: heardParts.reduce((n, p) => n + p.heard, 0), mediaIn: c.mediaIn };
  };

  // The window: per second, every process's CPU and the server's own loop view.
  const serverPids = [server.child.pid!, ...childPids(server.child.pid!)];
  const loadPids = [carrier.pid!, ...floors.map((f) => f.pid!)];
  const cpuSamples = new Map<number, number[]>();
  const loopSamples = new Map<string, { elu: number[]; p99: number[] }>();
  let lastTicks = new Map([...serverPids, ...loadPids].map((p) => [p, cpuTicks(p) ?? 0]));
  const s0 = await stats();
  const t0 = Date.now();
  for (let i = 0; i < SECONDS; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const ticks = new Map([...serverPids, ...loadPids].map((p) => [p, cpuTicks(p) ?? 0]));
    for (const [pid, t] of ticks) {
      const list = cpuSamples.get(pid) ?? [];
      list.push(((t - (lastTicks.get(pid) ?? t)) / CLK_TCK) * 100);
      cpuSamples.set(pid, list);
    }
    lastTicks = ticks;
    {
      const d = await server.detail().catch(() => null);
      for (const p of [...(d?.processes ?? [])]) {
        if (!p) continue;
        const key = `${p.role}${p.role === 'primary' || p.role === 'single' ? '' : p.slot}`;
        const s = loopSamples.get(key) ?? { elu: [], p99: [] };
        s.elu.push(p.elu);
        s.p99.push(p.loopDelayP99Ms);
        loopSamples.set(key, s);
      }
    }
  }
  const s1 = await stats();
  const secs = (Date.now() - t0) / 1000;
  const avg = (xs: number[] = []) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);
  const max = (xs: number[] = []) => (xs.length ? Math.max(...xs) : null);

  const bridgedAtEnd = await bridged();
  const report = {
    calls: CALLS,
    bridgedAtWindowStart: bridgedAtStart,
    bridgedAtWindowEnd: bridgedAtEnd,
    mediaWorkers: MEDIA_WORKERS,
    windowSeconds: SECONDS,
    joinedMs,
    allBridgedMs: bridgedMs,
    framesPerSecond: {
      expectedEachWay: bridgedAtStart * 50,
      heardByAgents: Math.round((s1.heard - s0.heard) / secs),
      receivedByCarrier: Math.round((s1.mediaIn - s0.mediaIn) / secs),
    },
    serverProcesses: serverPids.map((pid, i) => ({ pid, role: i === 0 ? (MEDIA_WORKERS > 0 ? 'primary' : 'single') : 'child', cpuPct: avg(cpuSamples.get(pid)) })),
    serverLoops: Object.fromEntries([...loopSamples].map(([k, v]) => [k, { elu: avg(v.elu), eluMax: max(v.elu), loopDelayP99Ms: avg(v.p99) }])),
    loadGenerators: loadPids.map((pid, i) => ({ pid, role: i === 0 ? 'carrier' : 'floor', cpuPct: avg(cpuSamples.get(pid)) })),
  };
  console.log(JSON.stringify(report, null, 2));

  cleanup = null;
  for (const f of floors) f.send({ stop: true });
  carrier.send({ stop: true });
  const stopped = await server.stop();
  console.log(JSON.stringify({ serverStop: stopped }));
  await closePool();
  await closeTestPool();
  process.exit(0);
}

/** Whatever this run started, stopped on any exit: an orphaned server would keep dialling the next run's database. */
let cleanup: (() => void) | null = null;
process.on('exit', () => cleanup?.());

main().catch((err) => { console.error(err); process.exit(1); });
