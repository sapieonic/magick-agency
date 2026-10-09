import { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useTenant } from './TenantContext';
import type { AgencyAccountSettings } from '@magick-agency/contracts/api/platform/settings';

/**
 * PORT NOTE (magick-agency): cusui's `GovernanceContext` @ ee5beb44 fetched
 * `GET /governance/effective` for the active `(tenant, account)` and exposed
 * master's capability map. Magick Agency has no governance (extraction plan
 * §3.2): the facts that map carried for the agency product are ONE per-account
 * settings row, and the session payload already carries every reachable
 * account's row, keyed by account id (`SessionResponse.settings`). So the map is
 * now DERIVED from `useAuth().settings[accountId]` — no request — and the
 * context keeps its name and its value shape so every ported reader
 * (`RequireCapability`, `AgentLanding`, `HomeRedirect`, the campaign builder's
 * per-field checks, `TeamPage`) is unchanged.
 *
 * The derivation, capability by capability (`capabilityMapFromSettings`):
 *  - `agency` — always `true`. The section-level gate is always on, because the
 *    app IS agency (plan §3.2).
 *  - `agency.recording` — the active account's `allow_recording`.
 *  - `agency.analytics` — the active account's `analyze_calls`.
 * Every other key is absent, so `isEnabled` answers `true` for it — cusui's
 * fail-OPEN rule, unchanged: this is L1 (UX) gating and the server's 403 is the
 * real enforcement. That includes `calls.dialer.analytics`, the capability
 * master gated the profile LIST behind: agency gates that read on the
 * `agency.analysis_profiles.read` permission alone.
 *
 * An account with no settings row in the session (the payload is resolved at
 * sign-in; an account created after it, or no active account) leaves both
 * per-field keys absent — fail-open, as a missing governance map did. The
 * server's per-field check on campaign writes (MAG-138) refuses regardless.
 */
interface GovernanceContextValue {
  /** Effective capability map for the ACTIVE (tenant, account). */
  map: Record<string, boolean>;
  loading: boolean;
  /**
   * Fail-OPEN: unknown/missing key ⇒ enabled. Only an explicit `false` hides a
   * capability. This is L1 (UX) gating — the server's 403 is the real
   * enforcement, so a missing map must never blank the app (design §2.3).
   */
  isEnabled: (capability: string) => boolean;
  /** Re-reads the session (`GET /auth/me`), which carries the settings map. */
  refresh: () => Promise<void>;
}

const GovernanceContext = createContext<GovernanceContextValue | null>(null);

/** The capability map one account's settings row stands for. See the PORT NOTE above. */
export function capabilityMapFromSettings(
  settings: AgencyAccountSettings | undefined,
): Record<string, boolean> {
  const map: Record<string, boolean> = { agency: true };
  if (settings) {
    map['agency.recording'] = settings.allow_recording;
    map['agency.analytics'] = settings.analyze_calls;
  }
  return map;
}

export function GovernanceProvider({ children }: { children: ReactNode }) {
  const { settings, loading: authLoading, refreshSession } = useAuth();
  const { accountId } = useTenant();

  const map = useMemo(
    () => capabilityMapFromSettings(accountId ? settings[accountId] : undefined),
    [settings, accountId],
  );

  const isEnabled = useCallback(
    (capability: string): boolean => map[capability] !== false,
    [map],
  );

  const refresh = useCallback(async () => { await refreshSession(); }, [refreshSession]);

  return (
    <GovernanceContext.Provider value={{ map, loading: authLoading, isEnabled, refresh }}>
      {children}
    </GovernanceContext.Provider>
  );
}

export function useGovernance(): GovernanceContextValue {
  const ctx = useContext(GovernanceContext);
  if (!ctx) throw new Error('useGovernance must be used within GovernanceProvider');
  return ctx;
}
