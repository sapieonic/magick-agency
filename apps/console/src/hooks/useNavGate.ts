import { useMemo } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { dialerOn, type GateInput } from '../utils/consoleNav';
import { useGateReaders } from './useGateReaders';
import { useMissedCallsAccess } from './useMissedCallsAccess';

/**
 * The reader's input to every navigation gate (`utils/consoleNav`): the role, and the flag and
 * capability readers failing closed outside their providers (`useGateReaders`). Memoised, so it
 * keeps its identity while none of them changes and can be a dependency as it is.
 *
 * `missed`: read the Missed-calls rule as well (`useMissedCallsAccess().available`), for the
 * gates that carry it. Read only where it can hold, with the dialer on and an account chosen, and
 * through the badge's one shared count. Not asked for, or not readable, `missedAvailable` is
 * false.
 */
export function useNavGate({ missed = false }: { missed?: boolean } = {}): GateInput {
  const { role, accountId } = useTenant();
  const { isFlagEnabled, isCapabilityEnabled } = useGateReaders();
  const readMissed = missed && Boolean(accountId) && dialerOn({ isFlagEnabled, isCapabilityEnabled });
  const { available } = useMissedCallsAccess({ enabled: readMissed });
  return useMemo(
    () => ({ role, isFlagEnabled, isCapabilityEnabled, missedAvailable: available }),
    [role, isFlagEnabled, isCapabilityEnabled, available],
  );
}
