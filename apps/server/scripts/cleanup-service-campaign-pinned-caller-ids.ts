/**
 * One-off clean-up (CR9, docs/carriers.md §6): take the caller IDs that are numbers pinned to a
 * tenant's carrier credential off campaigns on the service's own carrier account.
 *
 * CR9 refuses such a caller ID at the write, for the IDs a write adds. A campaign saved before
 * CR9, or written while one of its numbers was being moved onto a tenant's account (CR6), may
 * still hold one, and dials the tenant's number on the service's account. This finds every
 * campaign with no credential (`telephony_credential_id IS NULL`) that is not finished (draft,
 * running, paused or stopping: the set a credential revoke reads, `LIVE_CAMPAIGN`) whose
 * `caller_ids` hold a number with `phone_numbers.telephony_credential_id` set, and prints each
 * (tenant, account, campaign, status, the pinned caller IDs and the credential each is pinned to,
 * how many caller IDs would remain). Nothing is written without `--apply`.
 *
 * `--apply` removes those caller IDs, one campaign per transaction with the campaign row locked
 * `FOR UPDATE` and everything re-checked under the lock, and writes in that transaction the row a
 * supervisor's caller-ID edit writes (`agency_campaign.config_changed`, IN8: the changed fields
 * and `{ from, to }`), with a system actor and `details.actor = 'system:cr9-cleanup'`.
 *
 * A campaign it would leave with no caller ID is skipped and listed for an operator to decide,
 * unless `--allow-empty`; a running one is never emptied (it would dial nothing and say nothing).
 * Idempotent: a second `--apply` finds nothing. Exits 1 if any campaign failed, 2 on bad usage.
 *
 * A running server sees the change without a restart: the pacing engine re-reads a campaign row
 * at most 2 s after its last read (`PACING_CACHE_TTL_MS`), and a service-account campaign's caller
 * IDs are not otherwise cached (the dialable caller-ID cache holds credential campaigns only). The
 * pacing bus and the cache-invalidation channel reach only the processes of one server (in-process
 * and over its media workers' IPC), so a script cannot publish on them. A dedicated caller ID
 * (DN1) on a removed number stays stored and is ignored at the dial, as after a supervisor's edit.
 *
 * Usage (DATABASE_URL in the environment), from apps/server:
 *
 *   pnpm tsx scripts/cleanup-service-campaign-pinned-caller-ids.ts                 # dry run
 *   pnpm tsx scripts/cleanup-service-campaign-pinned-caller-ids.ts --apply         # write
 *   pnpm tsx scripts/cleanup-service-campaign-pinned-caller-ids.ts --apply --allow-empty
 *
 * In the production image it is bundled to `dist/cleanup-service-campaign-pinned-caller-ids.js`:
 *
 *   docker compose -f docker/docker-compose.prod.yml exec server \
 *     node dist/cleanup-service-campaign-pinned-caller-ids.js [--apply] [--allow-empty]
 *
 * The connection uses the server's Postgres settings (`DB_SSL_CA`, `DB_SSL_REJECT_UNAUTHORIZED`,
 * through `dbTlsOptions`), as `create-super-admin.ts` does; only the base config block is read.
 */
import { closePool, initDbPool } from '@magick-agency/db';
import { platformAuditRepository } from '@magick-agency/db/repositories/platform/audit.repository';
// The leaf, not the agency barrel: the barrel reaches modules that read the whole server config.
import {
  agencyServicePinnedCallerIdRepository,
  type PinnedCallerId,
  type ServiceCampaignPinnedCallerIds,
} from '../src/db/repositories/agency/service-pinned-caller-ids.repository.js';
import { campaignConfigChange } from '../src/agency/campaign-config-audit.js';
import { SYSTEM_AUDIT_ACTOR } from '../src/audit/platform/audit-actor.js';
import type { PlatformCreateAuditLogInput } from '../src/audit/platform/audit-logger.js';
import { baseConfigSchema, readBaseEnv } from '../src/config/blocks/base.js';
import { dbTlsOptions } from '../src/db-tls.js';
import { DB_APPLICATION_NAMES } from '../src/db-session.js';
import type { Env } from '../src/config/env.js';

/** Who made the change, on the audit row (`details.actor`; the row's `actor_type` is `system`). */
export const CR9_CLEANUP_ACTOR = 'system:cr9-cleanup';

export interface CleanupOptions {
  /** Write the changes; false (the default) only prints what would change. */
  apply: boolean;
  /** Empty a campaign that is not running when every caller ID it holds is pinned. */
  allowEmpty: boolean;
  /** Where each line goes (stdout by default). */
  out?: (line: string) => void;
}

/** What became of one campaign. */
export type CampaignCleanupResult =
  | 'would_remove' | 'removed'
  /** It would be left with no caller ID: not without `--allow-empty`. */
  | 'skipped_empty'
  /** Running, and it would be left with no caller ID: never emptied. */
  | 'skipped_running_empty'
  /** Re-checked under the lock: nothing to do any more. */
  | 'unchanged'
  | 'failed';

export interface CleanupSummary {
  apply: boolean;
  found: number;
  results: Array<{ campaign_id: string; result: CampaignCleanupResult; removed: string[]; error?: string }>;
  counts: Record<CampaignCleanupResult, number>;
}

function pinnedLine(p: PinnedCallerId, campaignTenantId: string): string {
  const label = p.credential_label === null ? 'credential not found' : `"${p.credential_label}"`;
  const tenant = p.credential_tenant_id !== null && p.credential_tenant_id !== campaignTenantId
    ? `, another tenant's (${p.credential_tenant_id})` : '';
  return `    ${p.phone_number} pinned to credential ${p.telephony_credential_id} ${label}${tenant}`;
}

function describe(c: ServiceCampaignPinnedCallerIds, out: (line: string) => void): void {
  out(`${c.tenant_name} (${c.tenant_id}) / ${c.account_name ?? 'account not found'} (${c.account_id})`);
  out(`  campaign ${c.campaign_id} "${c.campaign_name}", ${c.status}`);
  out(`  pinned caller IDs (${c.pinned.length}):`);
  for (const p of c.pinned) out(pinnedLine(p, c.tenant_id));
  out(`  ${c.remaining.length} of ${c.caller_ids.length} caller IDs would remain`);
}

/** Whether removing the pinned IDs is held back for leaving the campaign empty, and why. */
function emptyHold(c: Pick<ServiceCampaignPinnedCallerIds, 'status' | 'remaining'>, allowEmpty: boolean): CampaignCleanupResult | null {
  if (c.remaining.length > 0) return null;
  if (c.status === 'running') return 'skipped_running_empty';
  return allowEmpty ? null : 'skipped_empty';
}

/** The `agency_campaign.config_changed` row a supervisor's caller-ID edit writes (IN8), for this removal. */
export function cleanupAuditRow(input: {
  campaign: { id: string; tenant_id: string; account_id: string };
  before: string[];
  after: string[];
  removed: PinnedCallerId[];
}): PlatformCreateAuditLogInput {
  const change = campaignConfigChange({ caller_ids: input.after }, { caller_ids: input.before }, { caller_ids: input.after });
  return {
    tenant_id: input.campaign.tenant_id,
    account_id: input.campaign.account_id,
    ...SYSTEM_AUDIT_ACTOR,
    action: 'agency_campaign.config_changed',
    resource_type: 'agency_campaign',
    resource_id: input.campaign.id,
    campaign_id: input.campaign.id,
    details: {
      campaign_id: input.campaign.id,
      fields: change?.fields ?? ['caller_ids'],
      changes: change?.changes ?? {},
      actor: CR9_CLEANUP_ACTOR,
      via: 'cli',
      ruling: 'CR9',
      removed: input.removed.map((p) => ({ phone_number: p.phone_number, telephony_credential_id: p.telephony_credential_id })),
    },
  };
}

/** Find, print and (with `apply`) clean every campaign. Throws only if the first read fails. */
export async function cleanupServiceCampaignPinnedCallerIds(opts: CleanupOptions): Promise<CleanupSummary> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const found = await agencyServicePinnedCallerIdRepository.findServiceCampaignsHoldingPinned();
  const summary: CleanupSummary = {
    apply: opts.apply,
    found: found.length,
    results: [],
    counts: { would_remove: 0, removed: 0, skipped_empty: 0, skipped_running_empty: 0, unchanged: 0, failed: 0 },
  };
  const note = (campaignId: string, result: CampaignCleanupResult, removed: string[] = [], error?: string) => {
    summary.counts[result] += 1;
    summary.results.push({ campaign_id: campaignId, result, removed, ...(error ? { error } : {}) });
  };

  out(opts.apply ? 'Applying (--apply).' : 'Dry run: nothing is written (pass --apply to write).');
  if (found.length === 0) out('No unfinished service-account campaign holds a pinned caller ID.');

  for (const c of found) {
    out('');
    describe(c, out);
    const held = emptyHold(c, opts.allowEmpty);
    if (held) {
      out(held === 'skipped_running_empty'
        ? '  SKIPPED: running, and it would be left with no caller ID (never emptied); an operator decides'
        : '  SKIPPED: it would be left with no caller ID; an operator decides (or re-run with --allow-empty)');
      note(c.campaign_id, held);
      continue;
    }
    if (!opts.apply) {
      out(`  would remove ${c.pinned.length}`);
      note(c.campaign_id, 'would_remove', c.pinned.map((p) => p.phone_number));
      continue;
    }
    try {
      const removal = await agencyServicePinnedCallerIdRepository.removePinnedCallerIds(c.campaign_id, {
        allowEmpty: opts.allowEmpty,
        record: async (r, client) => {
          await platformAuditRepository.insertBatch([cleanupAuditRow(r)], client);
        },
      });
      if (removal.outcome === 'removed') {
        out(`  REMOVED ${removal.removed.map((p) => p.phone_number).join(', ')}; ${removal.after.length} caller IDs remain`);
        note(c.campaign_id, 'removed', removal.removed.map((p) => p.phone_number));
      } else if (removal.outcome === 'would_empty') {
        // Re-checked under the lock: the campaign changed since it was listed.
        const result = removal.campaign.status === 'running' ? 'skipped_running_empty' : 'skipped_empty';
        out('  SKIPPED: under the lock it would be left with no caller ID; an operator decides');
        note(c.campaign_id, result);
      } else {
        out(`  unchanged: ${removal.reason.replace(/_/g, ' ')} (re-checked under the lock)`);
        note(c.campaign_id, 'unchanged');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(`  FAILED: ${message} (nothing written for this campaign)`);
      note(c.campaign_id, 'failed', [], message);
    }
  }

  const k = summary.counts;
  out('');
  out(opts.apply
    ? `Summary: ${found.length} found; ${k.removed} cleaned, ${k.unchanged} unchanged, `
      + `${k.skipped_empty + k.skipped_running_empty} skipped (would be left empty: ${k.skipped_running_empty} running), ${k.failed} failed.`
    : `Summary (dry run): ${found.length} found; ${k.would_remove} would be cleaned, `
      + `${k.skipped_empty + k.skipped_running_empty} would be skipped (left empty: ${k.skipped_running_empty} running).`);
  return summary;
}

export function parseArgs(argv: string[]): { apply: boolean; allowEmpty: boolean; help: boolean; unknown: string[] } {
  const out = { apply: false, allowEmpty: false, help: false, unknown: [] as string[] };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--allow-empty') out.allowEmpty = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.unknown.push(arg);
  }
  return out;
}

const USAGE = 'usage: cleanup-service-campaign-pinned-caller-ids [--apply] [--allow-empty]  (DATABASE_URL required; dry run without --apply)';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length > 0 || !process.env['DATABASE_URL']) {
    if (args.unknown.length > 0) console.error(`unknown argument: ${args.unknown.join(' ')}`);
    console.error(USAGE);
    return 2;
  }
  // The server's own validation of DATABASE_URL and the TLS settings, and its TLS decision.
  const base = baseConfigSchema.pick({ server: true, db: true }).safeParse(readBaseEnv(process.env as Env));
  if (!base.success) {
    for (const issue of base.error.issues) console.error(`Invalid config: ${issue.path.join('.')}: ${issue.message}`);
    return 2;
  }
  initDbPool({ url: base.data.db.url, poolMin: 0, poolMax: 2, ...dbTlsOptions(base.data), applicationName: DB_APPLICATION_NAMES.cli });
  try {
    const summary = await cleanupServiceCampaignPinnedCallerIds({ apply: args.apply, allowEmpty: args.allowEmpty });
    return summary.counts.failed > 0 ? 1 : 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1]?.endsWith('cleanup-service-campaign-pinned-caller-ids.ts')
  || process.argv[1]?.endsWith('cleanup-service-campaign-pinned-caller-ids.js')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
