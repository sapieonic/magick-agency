import { useFeatureFlags } from '../contexts/FeatureFlagsContext';

/**
 * Whether one client-exposed flag is on — or `false` when there is no
 * `FeatureFlagsProvider` above the caller.
 *
 * For components that render on surfaces whose tests (and, in principle, whose
 * mounts) do not carry the provider — the agent nav, the station's action bar,
 * the agency sidebar — and that must fail CLOSED there rather than throw. Every
 * soft-phone affordance is behind `agency_softphone_enabled`, default off, so
 * "no provider" reading as "off" is the safe answer, the same one
 * `FeatureFlagsProvider` itself gives while loading or after an error.
 *
 * `useFeatureFlags` calls `useContext` before it throws on a missing provider, so
 * the hook order is the same on every render either way.
 */
export function useFeatureFlagEnabled(flag: string): boolean {
  try {
    return useFeatureFlags().isEnabled(flag);
  } catch {
    return false;
  }
}

/** The soft phone's flag (`docs/softphone.md`, SP4). */
export const SOFTPHONE_FLAG = 'agency_softphone_enabled';
