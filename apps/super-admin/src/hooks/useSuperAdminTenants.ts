import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { listTenants } from '../api/super-admin';
import type { SuperAdminTenant } from '@magick-agency/contracts/api/platform/super-admin';

// Module-level, so its identity is stable and the resource loads once per mount.
const fetchTenants = async (): Promise<SuperAdminTenant[]> => (await listTenants()).tenants;

export function useSuperAdminTenants() {
  const { data: tenants, loading, error, reload } = useAsyncResource(fetchTenants, {
    initialData: [] as SuperAdminTenant[],
    errorMessage: 'Failed to load tenants',
  });
  return { tenants, loading, error, reload };
}
