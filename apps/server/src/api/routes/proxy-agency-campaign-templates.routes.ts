import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { noStoreHook } from './helpers/no-store.js';
import { registerCampaignTemplateReadRoutes } from './proxy-agency-campaign-templates/read.js';
import { registerCampaignTemplateWriteRoutes } from './proxy-agency-campaign-templates/write.js';
import { registerCampaignTemplateApplyRoutes } from './proxy-agency-campaign-templates/apply.js';

/**
 * Campaign templates (docs/campaign-templates.md, rulings CT1–CT18; the wire is
 * `packages/contracts/src/api/agency/campaign-templates.ts`), at the console's paths under
 * `/proxy/agency/`. The public layer of B16, its own tables (`agency_campaign_templates`, 0067)
 * through `AgencyCampaignTemplateRepository`; no `callCore` but apply's, which writes campaigns
 * through the campaign PATCH path.
 *
 *  - reads (`./proxy-agency-campaign-templates/read.ts`): `GET /campaign-templates`,
 *    `GET /campaign-templates/effective`, `GET /campaign-templates/:id`,
 *    `GET /campaign-templates/:id/versions`, `GET /campaign-templates/:id/versions/:n`;
 *  - writes (`./write.ts`): `POST /campaign-templates`, `PUT /campaign-templates/:id`,
 *    `POST|DELETE /campaign-templates/:id/default`, `POST /campaign-templates/:id/archive`,
 *    `POST /campaign-templates/:id/restore`;
 *  - apply (`./apply.ts`): `POST /campaign-templates/:id/apply` (CT16).
 *
 * Guards, in this order, on every route: the session and the tenant context (the hooks below),
 * then the route's own preHandlers (`templateGuards`): the RBAC floor (`agency.campaigns.write` to
 * read, `agency.campaign_templates.manage` to write, both to apply; CT3) and the
 * `agency_campaign_templates_enabled` flag (`403 feature_disabled`, the dialer gate's body shape,
 * CT17) before any body is read; then the template (`404 campaign_template_not_found` for one the
 * caller cannot see, a malformed id included: the routes validate their own ids, so the family
 * gets no wrapper id guard), who may write its scope (an organisation template: an organisation
 * admin with an organisation-wide seat, AA1), the body and the template refusals,
 * `{ error, code, message }` with the contract's status per code. Never cached by a browser
 * (`Cache-Control: no-store`): answers name people.
 */
export async function proxyAgencyCampaignTemplatesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);
  await registerCampaignTemplateReadRoutes(app);
  await registerCampaignTemplateWriteRoutes(app);
  await registerCampaignTemplateApplyRoutes(app);
}
