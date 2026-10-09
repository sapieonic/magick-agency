import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { usageCountsRepository } from '@magick-agency/db/repositories/usage-counts.repository';
import type {
  UsageCounts,
  UsageCountsResponse,
  UsageCountsTenantRow,
} from '@magick-agency/contracts/api/platform/super-admin-usage';
import { usageCountsQuerySchema } from '../validators/super-admin.validator.js';

/**
 * `GET /super-admin/usage` — read-only usage counts (plan §3.3).
 *
 * PORT NOTE (magick-agency): NEW. It replaces master's
 * `super-admin-usage.routes.ts` (credits and fleet usage proxied from core,
 * deleted with credits). Dials, answered and connected calls, talk seconds and
 * analysis audio seconds per tenant and account over `[from, to)` on the
 * attempt's `dialed_at` (`usageCountsRepository`). It charges nothing and writes
 * nothing, so it writes no audit row either.
 */

function zeroCounts(): UsageCounts {
  return { dials: 0, answered_calls: 0, connected_calls: 0, talk_seconds: 0, analysis_audio_seconds: 0 };
}

function addInto(target: UsageCounts, add: UsageCounts): void {
  target.dials += add.dials;
  target.answered_calls += add.answered_calls;
  target.connected_calls += add.connected_calls;
  target.talk_seconds += add.talk_seconds;
  target.analysis_audio_seconds += add.analysis_audio_seconds;
}

export async function superAdminUsageCountsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', superAdminMiddleware);

  app.get('/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = usageCountsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
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
      const counts: UsageCounts = {
        dials: row.dials,
        answered_calls: row.answered_calls,
        connected_calls: row.connected_calls,
        talk_seconds: row.talk_seconds,
        analysis_audio_seconds: row.analysis_audio_seconds,
      };
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
