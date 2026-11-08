import type { Role } from '../types/auth';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { hasPermission } from '../utils/permissions';
import { isDedicatedAgent } from '../utils/agencyPersona';
import { useFeatureFlagEnabled } from './useFeatureFlagEnabled';
import { REPORTS_FLAG } from '../utils/reports/reportsFlag';

export { REPORTS_FLAG };

/**
 * Who may see and run reports here (`docs/reports.md` "Who may run what", RP5).
 *
 * - The flag `agency_reports_enabled` (default off) hides every reports affordance:
 *   the nav entries, the pages and the four export entry points. It is read through
 *   `useFeatureFlagEnabled`, so no provider, a flag map still loading or a failed read
 *   all read as off. The dialer flag is not re-checked here: every surface that shows
 *   one of these affordances is already inside the dialer gate.
 * - `agency.supervise` (account admin and up): every kind, the account's whole
 *   history, and subscriptions.
 * - Anyone else who can open a station: their OWN agent review only (the server
 *   builds it with the reduced `self` audience) and only the runs they requested.
 */

export interface ReportsAccess {
  /** The flag is on for this account. */
  enabled: boolean;
  /** `agency.supervise`: every kind, every run of the account, subscriptions. */
  canSupervise: boolean;
  /** May export their own agent review (and see their own runs). */
  canSelf: boolean;
  /** The signed-in user's id, the subject of a self export; null before the session resolves. */
  userId: string | null;
  /** Their display name (else email), the subject name of a self export. */
  userName: string | null;
  role: Role | undefined;
}

function useRoleOrNone(): Role | undefined {
  try {
    return useTenant().role;
  } catch {
    return undefined;
  }
}

function useUserOrNone(): { id: string; name: string | null } | null {
  try {
    const user = useAuth().user;
    return user ? { id: user.id, name: user.display_name || user.email || null } : null;
  } catch {
    return null;
  }
}

export function useReportsAccess(): ReportsAccess {
  const enabled = useFeatureFlagEnabled(REPORTS_FLAG);
  const role = useRoleOrNone();
  const user = useUserOrNone();
  return {
    enabled,
    canSupervise: hasPermission(role, 'agency.supervise'),
    canSelf: hasPermission(role, 'agency.station.connect'),
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    role,
  };
}

/**
 * Where the reports pages live for this person: `/dialer/reports` for a dedicated
 * agent (below every entry of the agency shell, so served in the agent's own frame,
 * like customer history), `/agency/reports` for everybody else.
 */
export function reportsBasePath(role: Role | undefined): '/dialer/reports' | '/agency/reports' {
  return isDedicatedAgent(role) ? '/dialer/reports' : '/agency/reports';
}

export function reportRunPath(role: Role | undefined, runId: string): string {
  return `${reportsBasePath(role)}/${encodeURIComponent(runId)}`;
}
