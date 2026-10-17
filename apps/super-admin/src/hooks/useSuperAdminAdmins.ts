import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { listAdmins } from '../api/super-admin';
import type { SuperAdmin } from '@magick-agency/contracts/api/platform/super-admin';

// Module-level, so its identity is stable and the resource loads once per mount.
const fetchAdmins = async (): Promise<SuperAdmin[]> => (await listAdmins()).admins;

export function useSuperAdminAdmins() {
  const { data: admins, loading, error, reload } = useAsyncResource(fetchAdmins, {
    initialData: [] as SuperAdmin[],
    errorMessage: 'Failed to load admins',
  });
  return { admins, loading, error, reload };
}
