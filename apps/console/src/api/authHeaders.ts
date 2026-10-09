import { getAuth } from 'firebase/auth';
import { ORIGINATOR, ORIGINATOR_HEADER } from '../config';

export async function buildAuthHeaders(
  tenantId?: string,
  accountId?: string,
): Promise<Record<string, string>> {
  const user = getAuth().currentUser;
  const token = user ? await user.getIdToken() : null;

  const headers: Record<string, string> = { [ORIGINATOR_HEADER]: ORIGINATOR };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (accountId) headers['X-Account-Id'] = accountId;

  return headers;
}
