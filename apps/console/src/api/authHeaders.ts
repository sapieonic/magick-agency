import { getAuth } from 'firebase/auth';
import { CLIENT_HEADERS } from '../config';

export async function buildAuthHeaders(
  tenantId?: string,
  accountId?: string,
): Promise<Record<string, string>> {
  const user = getAuth().currentUser;
  const token = user ? await user.getIdToken() : null;

  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (accountId) headers['X-Account-Id'] = accountId;

  return headers;
}
