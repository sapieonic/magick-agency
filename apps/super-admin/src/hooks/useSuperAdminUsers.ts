import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { listAllUsers } from '../api/super-admin';
import type { SuperAdminUser } from '@magick-agency/contracts/api/platform/super-admin';

// Module-level, so its identity is stable and the resource loads once per mount.
const fetchUsers = async (): Promise<SuperAdminUser[]> => (await listAllUsers()).users;

export function useSuperAdminUsers() {
  const { data: users, loading, error, reload } = useAsyncResource(fetchUsers, {
    initialData: [] as SuperAdminUser[],
    errorMessage: 'Failed to load users',
  });
  return { users, loading, error, reload };
}
