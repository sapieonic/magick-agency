import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { usageCountsRepository } from '@magick-agency/db/repositories/usage-counts.repository';
import type {
  UsageCounts,
  UsageCountsResponse,
  UsageCountsTenantRow,
} from '@magick-agency/contracts/api/platform/super-admin-usage';
import { usageCountsQuerySchema } from '../validators/super-admin.validator.js';
import { parseOr400 } from './helpers/parse-or-400.js';

/**
 * `GET /super-admin/usage` — read-only usage counts.
 *
 * Dials, answered and connected calls, talk seconds and
 * analysis audio seconds per tenant and account over `[from, to)` on the
 * attempt's `dialed_at`, and inbound calls apart, on their arrival
 * (`usageCountsRepository`). It charges nothing and writes
 * nothing, so it writes no audit row either.
 */

/** Every count, in wire order: what a row carries, and what the tenant and grand totals sum. */
const COUNT_KEYS = [
  'dials', 'answered_calls', 'connected_calls', 'talk_seconds', 'analysis_audio_seconds',
  'inbound_calls', 'inbound_answered_calls', 'inbound_connected_calls', 'inbound_seconds',
  'inbound_hold_seconds', 'inbound_talk_seconds', 'inbound_analysis_audio_seconds',
] as const satisfies ReadonlyArray<keyof UsageCounts>;

function zeroCounts(): UsageCounts {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as unknown as UsageCounts;
}

function countsOf(row: UsageCounts): UsageCounts {
  return Object.fromEntries(COUNT_KEYS.map((k) => [k, row[k]])) as unknown as UsageCounts;
}

function addInto(target: UsageCounts, add: UsageCounts): void {
  for (const k of COUNT_KEYS) target[k] += add[k];
}

export async function superAdminUsageCountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', superAdminMiddleware);

  app.get('/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(usageCountsQuerySchema, request.query, reply, 'platform');
    if (!parsed) return reply;
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);

    const rows = await usageCountsRepository.countByAccount({
      from,
      to,
      tenantId: parsed.data.tenant_id,
      accountId: parsed.data.account_id,
    });

    // Rows arrive ordered by tenant then account, so tenants are grouped in
    // first-seen order. Every sum is integer addition of exact counts.
    const totals = zeroCounts();
    const tenants: UsageCountsTenantRow[] = [];
    const byTenant = new Map<string, UsageCountsTenantRow>();
    for (const row of rows) {
      const counts = countsOf(row);
      let tenant = byTenant.get(row.tenant_id);
      if (!tenant) {
        tenant = { tenant_id: row.tenant_id, tenant_name: row.tenant_name, counts: zeroCounts(), accounts: [] };
        byTenant.set(row.tenant_id, tenant);
        tenants.push(tenant);
      }
      tenant.accounts.push({ account_id: row.account_id, account_name: row.account_name, counts });
      addInto(tenant.counts, counts);
      addInto(totals, counts);
    }

    const body: UsageCountsResponse = {
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      tenants,
    };
    return reply.send(body);
  });
}
