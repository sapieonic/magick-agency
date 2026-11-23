/**
 * The values a campaign write normalises as it stores them, one definition for every writer: the
 * internal create and PATCH (`api/routes/agency-campaigns/crud.ts`), a retry's overrides, and
 * campaign templates (a template's sections are saved as a campaign stores them, and the create's
 * fill-in compares what it sends as it will be stored, so a campaign made from a template compares
 * equal to it, CT9). Pure; a caller's object is never changed.
 *
 *  - `caller_ids`: each trimmed (the shape check, `callerIdsIssue`, counts them trimmed);
 *  - `agent_script`: its texts trimmed (`normalizeAgentScript`, BE-8).
 */
import { normalizeAgentScript } from './agent-script.js';

/** A caller-ID pool as a campaign stores it: each number trimmed. */
export function trimCallerIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.trim());
}

/**
 * `values` with the fields a campaign write normalises as it stores them (module note); a field it
 * does not carry, or one not of the shape the normaliser reads, is left as it is (the checks judge it).
 */
export function storedSettingValues<T extends Record<string, unknown>>(values: T): T {
  const out: Record<string, unknown> = { ...values };
  const callerIds = out['caller_ids'];
  if (Array.isArray(callerIds) && callerIds.every((id) => typeof id === 'string')) out['caller_ids'] = trimCallerIds(callerIds);
  if (out['agent_script'] !== undefined) out['agent_script'] = normalizeAgentScript(out['agent_script']);
  return out as T;
}
