import type { AgencyStationMediaFormat } from '@magick-agency/contracts/agency';
import type { ClientExposedAgencyFlagKey } from '@magick-agency/contracts/flags';
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

/**
 * The call-audio format flag: on (the default), the station socket carries binary
 * A-law (`alaw8`); off, base64 PCM16 (`pcm16`), the tenant's way back without a
 * deploy. Typed against the contracts so a renamed or withdrawn flag fails to compile.
 */
export const CONSOLE_ALAW8_FLAG: ClientExposedAgencyFlagKey = 'agency_console_alaw8';

/**
 * The station socket format this console asks for. **Fails to `pcm16`**, like every
 * flag read here (no provider, still loading, a failed read): the format every server
 * speaks, at the higher server cost, never a call without audio.
 */
export function useStationMediaFormat(): AgencyStationMediaFormat {
  return useFeatureFlagEnabled(CONSOLE_ALAW8_FLAG) ? 'alaw8' : 'pcm16';
}
