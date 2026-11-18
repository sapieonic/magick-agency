/**
 * Re-queue the post-call analysis jobs a recording-host refusal failed, once the allow-list
 * fix that cures them has deployed (Plivo's regional media hosts, PL6 as amended 2026-11-18:
 * before it, every recording on `aps1.media.plivo.com` failed its analysis at once with
 * `TRANSCRIPTION_FAILED`, not retried, as an off-list host is permanent).
 *
 * Selects only `failed` jobs whose error is a host refusal
 * (`dialerAnalysisJobRepository.findRecordingHostRefusals`: `TRANSCRIPTION_FAILED` and the
 * message `Recording host "<host>" is not on the recording-host allow-list`), on calls not
 * erased, optionally narrowed to one refused host, one tenant and a failure window. Each is
 * re-queued exactly as a manual retry is (`requeueForManualRetry`): status `queued` with the
 * worker's full attempt budget, never past the lifetime ceiling
 * (`DIALER_ANALYSIS_MAX_ATTEMPTS_TOTAL`), and the call row mirrored `pending`. The worker then
 * picks them up like any queued job, on the allow-list the server now runs.
 *
 * A DRY RUN unless `--apply`: it prints what it would re-queue and the count, changing nothing.
 *
 *   pnpm tsx scripts/requeue-recording-host-refusals.ts --host aps1.media.plivo.com --since 2026-11-17T00:00:00Z
 *   pnpm tsx scripts/requeue-recording-host-refusals.ts --host aps1.media.plivo.com --since 2026-11-17T00:00:00Z --apply
 *
 * Options: `--host <host>` (the refused host as the log named it), `--tenant <uuid>`,
 * `--since <ISO time>` / `--before <ISO time>` (when the job failed), `--limit <n>` (default
 * 1000, at most 10000), `--apply`. In the production image it is `dist/requeue-recording-host-refusals.js`:
 *
 *   docker compose -f docker/docker-compose.prod.yml exec server \
 *     node dist/requeue-recording-host-refusals.js --host aps1.media.plivo.com --since 2026-11-17T00:00:00Z
 *
 * Only the base config block (`DATABASE_URL`, TLS) and the two attempt ceilings are read, so it
 * needs no carrier or AI settings. Run it only after the fix is live: a job re-queued onto a
 * server that still refuses the host fails again, and spends one more of its lifetime attempts.
 */
import { initDbPool, closePool } from '@magick-agency/db';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';
import { baseConfigSchema, readBaseEnv } from '../src/config/blocks/base.js';
import { analysisAttemptLimitsSchema } from '../src/config/blocks/analysis.js';
import { dbTlsOptions } from '../src/db-tls.js';
import { DB_APPLICATION_NAMES } from '../src/db-session.js';
import type { Env } from '../src/config/env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_LIMIT = 10_000;

export interface RequeueArgs {
  host?: string;
  tenantId?: string;
  failedSince?: Date;
  failedBefore?: Date;
  limit: number;
  apply: boolean;
}

/** Parse and validate the command line; ids and times are checked here, at the edge. */
export function parseArgs(argv: string[]): { ok: true; args: RequeueArgs } | { ok: false; error: string } {
  const args: RequeueArgs = { limit: 1000, apply: false };
  const time = (flag: string, raw: string | undefined): Date | string => {
    const at = raw ? new Date(raw) : new Date(Number.NaN);
    return Number.isNaN(at.getTime()) ? `${flag} takes an ISO time (e.g. 2026-11-17T00:00:00Z)` : at;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--apply':
        args.apply = true;
        continue;
      case '--host': {
        const host = (value ?? '').toLowerCase();
        if (!HOST.test(host)) return { ok: false, error: '--host takes a bare hostname (e.g. aps1.media.plivo.com)' };
        args.host = host;
        break;
      }
      case '--tenant':
        if (!value || !UUID.test(value)) return { ok: false, error: '--tenant takes a tenant id (a UUID)' };
        args.tenantId = value;
        break;
      case '--since': {
        const at = time('--since', value);
        if (typeof at === 'string') return { ok: false, error: at };
        args.failedSince = at;
        break;
      }
      case '--before': {
        const at = time('--before', value);
        if (typeof at === 'string') return { ok: false, error: at };
        args.failedBefore = at;
        break;
      }
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, error: `--limit takes a whole number from 1 to ${MAX_LIMIT}` };
        args.limit = n;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${String(flag)}` };
    }
    i++;
  }
  return { ok: true, args };
}

export interface RequeueResult {
  /** The failed jobs the selector matched (at most `limit`). */
  matched: DialerAnalysisJobRecord[];
  /** Re-queued (empty on a dry run). */
  requeued: string[];
  /** Matched but not re-queued: its lifetime ceiling is reached, or it changed since it was read. */
  notRequeued: string[];
}

/** Select, and with `apply` re-queue each as a manual retry. */
export async function requeueRecordingHostRefusals(
  args: RequeueArgs,
  limits: { maxAttempts: number; maxAttemptsTotal: number },
): Promise<RequeueResult> {
  const matched = await dialerAnalysisJobRepository.findRecordingHostRefusals({
    ...(args.host ? { host: args.host } : {}),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    ...(args.failedSince ? { failedSince: args.failedSince } : {}),
    ...(args.failedBefore ? { failedBefore: args.failedBefore } : {}),
    limit: args.limit,
  });
  const result: RequeueResult = { matched, requeued: [], notRequeued: [] };
  if (!args.apply) return result;
  for (const job of matched) {
    const row = await dialerAnalysisJobRepository.requeueForManualRetry(job.call_id, {
      extraAttempts: limits.maxAttempts,
      attemptsTotalCeiling: limits.maxAttemptsTotal,
      settleSeconds: 0,
    });
    (row ? result.requeued : result.notRequeued).push(job.id);
  }
  return result;
}

/** The refused host a job's message names. */
function refusedHost(message: string | null): string {
  return /^Recording host "([^"]+)"/.exec(message ?? '')?.[1] ?? '?';
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok || !process.env['DATABASE_URL']) {
    if (!parsed.ok) console.error(parsed.error);
    console.error('usage: requeue-recording-host-refusals [--host <host>] [--tenant <uuid>] [--since <ISO>] [--before <ISO>] [--limit <n>] [--apply]  (DATABASE_URL required)');
    return 2;
  }
  const env = process.env as Env;
  const base = baseConfigSchema.pick({ server: true, db: true }).safeParse(readBaseEnv(env));
  const limits = analysisAttemptLimitsSchema.safeParse({
    maxAttempts: env['DIALER_ANALYSIS_MAX_ATTEMPTS'],
    maxAttemptsTotal: env['DIALER_ANALYSIS_MAX_ATTEMPTS_TOTAL'],
  });
  if (!base.success || !limits.success) {
    for (const issue of [...(base.error?.issues ?? []), ...(limits.error?.issues ?? [])]) {
      console.error(`Invalid config: ${issue.path.join('.')}: ${issue.message}`);
    }
    return 2;
  }
  const { args } = parsed;

  initDbPool({ url: base.data.db.url, poolMin: 0, poolMax: 2, ...dbTlsOptions(base.data), applicationName: DB_APPLICATION_NAMES.cli });
  try {
    const result = await requeueRecordingHostRefusals(args, limits.data);
    for (const job of result.matched) {
      console.log(`job ${job.id} call ${job.call_id} tenant ${job.tenant_id} failed ${job.updated_at.toISOString()} host ${refusedHost(job.error_message)}`);
    }
    const capped = result.matched.length === args.limit ? ` (the limit; run again for more)` : '';
    if (!args.apply) {
      console.log(`dry run: ${result.matched.length} failed job(s) match${capped}; nothing changed. Add --apply to re-queue them.`);
      return 0;
    }
    for (const id of result.notRequeued) console.log(`not re-queued: job ${id} (lifetime attempt ceiling reached, or no longer failed)`);
    console.log(`re-queued ${result.requeued.length} of ${result.matched.length} matched job(s)${capped}.`);
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1]?.endsWith('requeue-recording-host-refusals.ts') || process.argv[1]?.endsWith('requeue-recording-host-refusals.js')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
