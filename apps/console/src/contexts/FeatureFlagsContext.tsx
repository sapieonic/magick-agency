import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useTenant } from './TenantContext';
import { fetchFeatureFlags } from '../api/feature-flags';
import type { FeatureFlagMap, FeatureFlagStatus } from '../types/feature-flags';

interface FeatureFlagsContextValue {
  /** Resolved client-exposed flags for the current tenant/account. */
  flags: FeatureFlagMap;
  /** Resolution lifecycle — drives the anti-flicker render rule (UX §2.1). */
  status: FeatureFlagStatus;
  reload: () => void;
  /**
   * True only when the flag has resolved to a truthy value. While `loading` or
   * on `error` this returns false — fail-safe closed, matching core's
   * default-off posture (UX §2.1). Gate render-only decisions on this.
   */
  isEnabled: (flag: string) => boolean;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

/**
 * App-wide feature-flag provider. Loads `GET /proxy/feature-flags` once per
 * tenant/account (mounted in App.tsx inside TenantProvider, alongside
 * MetadataProvider) and exposes the resolved flags synchronously so any
 * component can gate render decisions without its own fetch.
 *
 * Named `useFeatureFlags` (plural) to avoid colliding with the unused PostHog
 * `useFeatureFlag` hook (singular).
 */
export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { tenantId, accountId, accountResolution } = useTenant();
  const [flags, setFlags] = useState<FeatureFlagMap>({});
  const [status, setStatus] = useState<FeatureFlagStatus>('loading');

  // Guard against a stale in-flight response landing after a fast tenant/account
  // switch (mirrors GovernanceContext's `loadedForKey` ref).
  const loadedForKey = useRef<string | null>(null);

  const load = useCallback(() => {
    // Feature flags are ACCOUNT-scoped — core's proxy 400s ("Missing required
    // header: x-mgkvc-account") if we fetch before the active account resolves.
    // Wait for accountId so we never fire a doomed request (which, being
    // fail-closed, would hide every flag-gated nav item). Stay in 'loading'
    // until then (fail-safe: gates stay off, never flicker on).
    if (!tenantId || !accountId || !user) {
      setFlags({});
      /**
       * **`'loading'` only while waiting is still honest.**
       *
       * This branch used to be unconditionally `'loading'`, and the missing case
       * is the one that shipped: when `TenantContext` fails to resolve an account
       * there is nothing left to wait for, so the wait never ends. `RequireFlag`
       * renders a spinner for `'loading'`, so an `agent` — 403'd from
       * `GET /accounts` — signed in to take calls and got a spinner with no error
       * and no console message, forever.
       *
       * `'error'` is the existing fail-safe-closed terminal state and it is the
       * right one: gates stay off (never flicker on), and — unlike `'loading'` —
       * it is a state a guard can render a sentence for.
       */
      /**
       * **Terminal whenever resolution has SETTLED without producing an account**,
       * not only on `'error'`.
       *
       * The narrower `=== 'error'` check missed two settled-but-accountless states
       * that are just as unwaitable, because in both of them
       * `accountsLoadedForTenant` is set and the tenant effect will never fire
       * again: a tenant with genuinely zero accounts (`'ready'`, empty list), and a
       * `'degraded'` fallback whose narrowed list is also empty. Both left this
       * context reporting `'loading'` forever, which is the same permanent spinner
       * from a different direction.
       *
       * `'loading'` is now reserved for what the word means: resolution is still in
       * flight and an account may yet arrive.
       */
      setStatus(accountResolution === 'loading' ? 'loading' : 'error');
      loadedForKey.current = null;
      return;
    }
    const key = `${tenantId}:${accountId}`;
    loadedForKey.current = key;
    setStatus('loading');
    fetchFeatureFlags(tenantId, accountId)
      .then((result) => {
        if (loadedForKey.current !== key) return; // superseded by a newer switch
        setFlags(result ?? {});
        setStatus('ready');
      })
      .catch(() => {
        if (loadedForKey.current !== key) return;
        // Fail-safe closed: an error resolves every gate to off (UX §2.1).
        setFlags({});
        setStatus('error');
      });
  }, [tenantId, accountId, user, accountResolution]);

  useEffect(() => { load(); }, [load]);

  const isEnabled = useCallback(
    (flag: string): boolean => status === 'ready' && flags[flag] === true,
    [status, flags],
  );

  return (
    <FeatureFlagsContext.Provider value={{ flags, status, reload: load, isEnabled }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) throw new Error('useFeatureFlags must be used within FeatureFlagsProvider');
  return ctx;
}
