/*
 * `GET /customers/options` (`docs/customer-history.md` §1): what the search box needs before the
 * first search, today the platform's default calling code (`DEFAULT_PHONE_COUNTRY_CODE`) in the
 * soft phone bootstrap's form (`+91`), so the country picker opens on the deployment's country
 * rather than one built into the client. Carries no customer data: not charged to the search cap,
 * not audited. Part of `proxy-agency-customers.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { CustomerSearchOptionsResponse } from '@magick-agency/contracts/api/agency/customer-history';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { defaultPhoneCountryCode } from '../../../utils/phone-normalizer.js';
import { guardCustomerRoute } from './shared.js';

export async function registerCustomerOptionsRoute(app: FastifyInstance): Promise<void> {
  app.get('/customers/options', {
    preHandler: requirePermission('agency.customer_history.read'),
  }, async (request, reply) => {
    if (!(await guardCustomerRoute(request, reply, null))) return reply;
    const answer: CustomerSearchOptionsResponse = { default_country_code: `+${defaultPhoneCountryCode()}` };
    return reply.code(200).send(answer);
  });
}
