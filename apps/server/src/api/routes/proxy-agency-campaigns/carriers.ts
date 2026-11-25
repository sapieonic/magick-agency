/*
 * `GET /proxy/agency/carriers`: the carrier accounts the tenant's campaigns may dial on
 * (decisions B18–B22). Part of `proxy-agency-campaigns.routes.ts`.
 *
 * Answered here, not by an internal handler: it is tenant data (a credential serves every
 * account of its tenant, B20) and holds no campaign, so there is nothing for the dialer
 * runtime to own. The list is what the campaign write accepts (`agency/campaign-carrier.ts`):
 *  - each active carrier with a service account (`carrierHasServiceAccount`), with no
 *    credential;
 *  - each `active` credential of the tenant on an active carrier that takes tenant
 *    accounts (`carrierTakesTenantAccounts`) and can dial from this server
 *    (`carrierDialReady`, PL12: not while its webhook base is unset): its id, carrier and
 *    label. Never `account_ref`, config or any secret.
 * Which accounts a carrier offers comes from its catalogue entry's account modes (CR1), not
 * its name.
 *
 * Floor `agency.campaigns.read`: an editor fills the campaign create and edit from it, and a
 * read-only viewer of a campaign's settings is told which carrier account it dials on. It
 * holds labels and ids only, nothing a viewer of the campaign could not already learn.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { telephonyProviderRepository } from '../../../db/repositories/telephony-provider.repository.js';
import { carrierHasServiceAccount, carrierTakesTenantAccounts } from '../../../telephony/carrier-catalog.js';
import { carrierDialReady } from '../../../telephony/carrier-dial-readiness.js';
import type { AgencyCarrier, AgencyCarriersResponse } from '@magick-agency/contracts/api/agency/agency-campaign';

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCarrierRoutes(app: FastifyInstance): Promise<void> {
  app.get('/carriers', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const tenantId = request.tenantId!;
    const [providers, credentials] = await Promise.all([
      telephonyProviderRepository.findAll('active'),
      telephonyCredentialRepository.list({ tenantId }),
    ]);
    const active = new Set(providers.map((p) => p.name));
    const carriers: AgencyCarrier[] = [
      ...providers
        .filter((p) => carrierHasServiceAccount(p.name))
        .map((p): AgencyCarrier => ({ telephony_provider: p.name, telephony_credential_id: null, label: null, status: 'active' })),
      ...credentials
        .filter((c) => c.status === 'active' && active.has(c.provider) && carrierTakesTenantAccounts(c.provider)
          && carrierDialReady(c.provider, 'tenant'))
        .map((c): AgencyCarrier => ({ telephony_provider: c.provider, telephony_credential_id: c.id, label: c.label, status: 'active' })),
    ];
    const body: AgencyCarriersResponse = { carriers };
    return reply.send(body);
  });
}
