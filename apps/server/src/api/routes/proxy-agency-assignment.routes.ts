import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerAssignmentSupervisorRoutes } from './proxy-agency-assignment/supervisor.js';
import { registerMyContactRoutes } from './proxy-agency-assignment/my-contacts.js';
import { registerMyContactActionRoutes } from './proxy-agency-assignment/my-contact-actions.js';

export { registerAssignmentSupervisorRoutes, registerMyContactRoutes, registerMyContactActionRoutes };

/**
 * Contact assignment, served at the console's paths under `/proxy/agency` (decision B16; the
 * wire is `packages/contracts/src/api/agency/assignment.ts`). The rows are
 * `agency_contacts.assigned_*` and `agency_contact_assignment_events`, read and written here
 * through the assignment repositories, with no internal handler hop except the campaign
 * ownership probe (`fetchOwnedCoreCampaign`) on the supervisor's routes.
 *
 *  - Supervisor (`agency.supervise`): preview / commit an operation, progress per agent, a
 *    contact's owner history (`./proxy-agency-assignment/supervisor.ts`).
 *  - Agent (`agency.contacts.own`, floored at `agent`): the caller's own contacts, summary
 *    and list (`./proxy-agency-assignment/my-contacts.ts`), and the actions on them: retry
 *    and the per-contact call (`./proxy-agency-assignment/my-contact-actions.ts`). Their subject is the caller,
 *    never a parameter, and they never ride a `viewer`-floored permission (the rule the
 *    staffing plugin's `my-*` routes state).
 *
 * Every route answers `403 assignment_disabled` while `agency_contact_assignment_enabled` is
 * off for the tenant / account (D9). The routes validate their own ids (404 for a malformed
 * campaign or contact id, the answer an unknown one gets), so the family gets no wrapper
 * id guard.
 */
export async function proxyAgencyAssignmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  await registerAssignmentSupervisorRoutes(app);
  await registerMyContactRoutes(app);
  await registerMyContactActionRoutes(app);
}
