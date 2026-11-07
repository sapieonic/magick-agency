import { Navigate, useLocation, useParams } from 'react-router-dom';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../../contexts/TenantContext';
import { campaignLandingPath } from '../../../utils/agencyCampaignTabs';

/**
 * `/agency/campaigns/:id` and the retired `…/performance` (decision IN1) and
 * `…/insights` (decision IN13).
 *
 * A supervisor lands on Overview. A viewer or operator cannot read it
 * (`agency.supervise`), so they land on the Agents panel, the one campaign
 * section every reader can open, rather than on a tab whose every read would 403.
 *
 * The query string travels (a link shared as `…/campaigns/:id?range=today`
 * keeps its range). `role` is `undefined` while the tenant context resolves a
 * membership; redirecting then would send a supervisor to Agents for one frame,
 * so it waits, as `AgencyHomeRedirect` does for the same reason.
 */
export function CampaignLandingRedirect() {
  const { id } = useParams<{ id: string }>();
  const { search } = useLocation();
  const { role } = useTenant();
  if (!id) return null;
  if (role === undefined) return <LoadingSpinner />;
  return <Navigate to={`${campaignLandingPath(id, role)}${search}`} replace />;
}

export default CampaignLandingRedirect;
