/**
 * Factories for the integration suites. The shared factories (UUID defaults, `agency_calls`)
 * live in packages/db; agency-specific ones are `../agency/agency-factories.ts`.
 */
export { DEFAULTS, OTHER_TENANT, OTHER_ACCOUNT, uuidFor, insertAccountSettings, insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';
// Tenant/account/user factories for the staffing suites
export { insertTenant, insertAccount, insertUser } from '../../../../../packages/db/test/integration/setup/factories.js';
