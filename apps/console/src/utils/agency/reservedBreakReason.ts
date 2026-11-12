import { RESERVED_BREAK_REASON_LABELS, type AgencyReservedBreakReason } from '../../types/agency';

/**
 * The label of a reserved break code (`soft_phone`, `device_away`, IQ51's `phone_call` and IQ58's `away_ring`:
 * the contract's `RESERVED_BREAK_REASON_LABELS`), or `null` for any other code.
 *
 * Reserved codes are never in a campaign's `break_reasons`, so no catalog carries a
 * label for them: every surface that writes a break reason (the agent's own station,
 * the supervisor's floor and drawer) asks here first and falls back to the catalog.
 * Without it a supervisor would read "On break · device_away", a wire code, for an
 * agent whose app went to the background.
 */
export function reservedBreakReasonLabel(code: string | null | undefined): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(RESERVED_BREAK_REASON_LABELS, code)) return null;
  return RESERVED_BREAK_REASON_LABELS[code as AgencyReservedBreakReason];
}
