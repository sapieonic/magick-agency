import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';

/**
 * The real server as a separate process tree (`src/index.ts` under tsx, exactly the entry
 * the image runs), for the multi-process tests and the load harness: with `MEDIA_WORKERS`
 * set it is a primary that forks its media (and analysis) workers. It inherits this
 * process's environment, so it uses the worktree's test database and Redis db.
 */
export interface ClusterServer {
  child: ChildProcess;
  port: number;
  origin: string;
  /** Everything the tree wrote to stdout and stderr, as lines. */
  output: string[];
  /** `/readyz?detail=1`: the per-process view. */
  detail(): Promise<{ status: string; processes?: Array<ProcessHealth | null> }>;
  /** SIGTERM the primary and wait for it to exit (bounded); returns how it went. */
  stop(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}

export interface ProcessHealth {
  role: string;
  slot: number;
  pid: number;
  elu: number;
  loopDelayP99Ms: number;
  inFlight: number;
  draining: boolean;
}

const SERVER_DIR = resolve(__dirname, '../..');

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function startClusterServer(env: Record<string, string>, opts: { readyTimeoutMs?: number } = {}): Promise<ClusterServer> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    // Partition maintenance creates and DROPS audit partitions at boot: on the shared test
    // database that would change the schema under the suites that run after this one.
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AUDIT_PARTITION_MAINTENANCE_ENABLED: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) output.push(line);
    if (output.length > 20_000) output.splice(0, output.length - 20_000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.once('exit', (code, signal) => r({ code, signal })));

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 90_000);
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot (${child.exitCode}):\n${output.slice(-40).join('\n')}`);
    const ok = await fetch(`${origin}/readyz`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server not ready within the timeout:\n${output.slice(-40).join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    child,
    port,
    origin,
    output,
    detail: async () => (await fetch(`${origin}/readyz?detail=1`)).json() as Promise<{ status: string; processes?: Array<ProcessHealth | null> }>,
    stop: async (timeoutMs = 60_000) => {
      const started = Date.now();
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const result = await exited;
      clearTimeout(timer);
      return { ...result, ms: Date.now() - started };
    },
  };
}
