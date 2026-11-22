import type { AgencyManualCallListQuery } from '../../types/softphone';

/**
 * The soft-phone Status filter's choices, as the Call log and All calls offer them with the
 * Soft phone chip on (`utils/agency/callLog.ts`). The rest of this file (the Soft-phone calls
 * list's stats strip and its filter draft) went with that list when All calls replaced it
 * (`docs/call-log.md` §7, CL34).
 */
export const SOFTPHONE_CALL_STATUS_OPTIONS: ReadonlyArray<{ value: NonNullable<AgencyManualCallListQuery['status']>; label: string }> = [
  { value: 'live', label: 'On a call now' },
  { value: 'awaiting_outcome', label: 'Waiting for an outcome' },
  { value: 'settled', label: 'Done' },
];
