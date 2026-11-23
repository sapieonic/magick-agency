import { useTenant } from '../../../contexts/TenantContext';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { hasPermission } from '../../../utils/permissions';
import { holdsOrganisationSeat } from '../../../utils/consoleNav';
import { CAMPAIGN_TEMPLATES_FLAG } from '../../../utils/agency/campaignTemplates/templatesFlag';

/**
 * Who may do what with campaign templates (CT3, CT17), as the routes decide it:
 *  - `use`: list templates and start New campaign from one (`agency.campaigns.write`);
 *  - `manage`: write the account's (`agency.campaign_templates.manage`);
 *  - `manageOrganisation`: write the organisation's, which also needs `tenant_admin` or above on
 *    an organisation-wide seat (the server's `tenant_wide_membership_required`).
 * Every one is false while `agency_campaign_templates_enabled` is off.
 */
export function useTemplatesAccess(): { on: boolean; use: boolean; manage: boolean; manageOrganisation: boolean } {
  const { role, organisationRole } = useTenant();
  const on = useFeatureFlagEnabled(CAMPAIGN_TEMPLATES_FLAG);
  const manage = on && hasPermission(role, 'agency.campaign_templates.manage');
  return {
    on,
    use: on && hasPermission(role, 'agency.campaigns.write'),
    manage,
    manageOrganisation: manage && holdsOrganisationSeat(organisationRole, 'tenant_admin'),
  };
}
