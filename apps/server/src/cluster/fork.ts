/**
 * How the primary forks a child of the server: the same entry it was started with
 * (`dist/index.js` in the image, `src/index.ts` under tsx), the same environment plus the
 * role and slot (`roles.ts`), and the same Node flags except the heap limit, which is
 * sized per role. The image's entrypoint sets `--max-old-space-size` for the process it
 * starts (the primary); a child inherits `execArgv`, so without the override every child
 * would also claim that heap.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { PROCESS_ROLE_ENV, WORKER_SLOT_ENV, type ChildRole } from './roles.js';

/** `execArgv` with any heap limit replaced by `heapMb` (or left alone when it is undefined). */
export function execArgvWithHeap(execArgv: readonly string[], heapMb: number | undefined): string[] {
  if (heapMb === undefined) return [...execArgv];
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    if (arg.startsWith('--max-old-space-size=')) continue;
    if (arg === '--max-old-space-size') { i++; continue; }
    out.push(arg);
  }
  out.push(`--max-old-space-size=${heapMb}`);
  return out;
}

export interface ForkServerChildOptions {
  role: ChildRole;
  slot: number;
  heapMb?: number;
  /** The entry to run. Default: this process's own (`process.argv[1]`). */
  entry?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function forkServerChild(opts: ForkServerChildOptions): ChildProcess {
  const entry = opts.entry ?? process.argv[1];
  if (!entry) throw new Error('cannot fork a child: this process has no entry script (process.argv[1])');
  return fork(entry, [], {
    env: { ...(opts.env ?? process.env), [PROCESS_ROLE_ENV]: opts.role, [WORKER_SLOT_ENV]: String(opts.slot) },
    execArgv: execArgvWithHeap(opts.execArgv ?? process.execArgv, opts.heapMb),
    // stdout and stderr are the container's, like the primary's own lines.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
  });
}

/**
 * The heap an analysis child needs: its recording budget (the bytes its slots may hold)
 * plus room for everything else in a Node process.
 */
export function analysisChildHeapMb(memoryBudgetBytes: number): number {
  return Math.ceil(memoryBudgetBytes / (1024 * 1024)) + 512;
}
