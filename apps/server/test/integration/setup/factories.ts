/**
 * PORT NOTE (magick-agency): stands in for core's `test/integration/setup/factories.ts`
 * for the ported agency suites. The shared factories (UUID defaults, `agency_calls`)
 * are the lead's, in packages/db; agency-specific ones are `../agency/agency-factories.ts`.
 */
export { DEFAULTS, OTHER_TENANT, OTHER_ACCOUNT, uuidFor, insertAccountSettings, insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';
// master's tenant/account/user factories (ported verbatim by the lead for the staffing suites)
export { insertTenant, insertAccount, insertUser } from '../../../../../packages/db/test/integration/setup/factories.js';
