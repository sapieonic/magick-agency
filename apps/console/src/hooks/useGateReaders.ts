import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { useGovernance } from '../contexts/GovernanceContext';
import type { GateInput } from '../utils/consoleNav';

/**
 * The flag and capability readers a navigation gate (`utils/consoleNav`) needs, failing CLOSED
 * outside their providers (every flag and capability off), as `useFeatureFlagEnabled` does: the
 * sidebar and the top bar render in tests, and in principle in mounts, without them.
 *
 * Both context hooks call `useContext` before they throw, so the hook order is the same on
 * every render either way.
 */
export function useGateReaders(): Pick<GateInput, 'isFlagEnabled' | 'isCapabilityEnabled'> {
  let isFlagEnabled: (flag: string) => boolean = closed;
  let isCapabilityEnabled: (capability: string) => boolean = closed;
  try {
    isFlagEnabled = useFeatureFlags().isEnabled;
  } catch {
    /* no provider: every flag off */
  }
  try {
    isCapabilityEnabled = useGovernance().isEnabled;
  } catch {
    /* no provider: every capability off */
  }
  return { isFlagEnabled, isCapabilityEnabled };
}

function closed(): boolean {
  return false;
}
