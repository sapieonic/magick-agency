import { AGENCY_SCRIPT_PLACEHOLDERS } from '../../types/agency';
import type { AgencyAgentScript, AgencyReservedAttempt, AgencyScriptPlaceholder } from '../../types/agency';
import { factText, factTilesInOrder } from './stationCustomer';

/**
 * The campaign's script on the call screens (BE-8; AS2: no AI): "First, say this" on Call coming
 * (03) and "What to say" on On call (04), each line filled for the customer on screen.
 *
 * ── The fill rule (the contract's, as the app's `fillScriptPlaceholders`) ────
 * `{word}` with a lower-case name: a known placeholder is replaced by its value, or by nothing when
 * this customer has none (the line still shows); a `{word}` the contract does not list is left as
 * written. Values are written as the card writes them: the amount due as `₹12,500` and the due date
 * as `20 Nov` when the server read them, else exactly as uploaded; the agent's first name; the
 * work's name.
 */

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN = new Set<string>(AGENCY_SCRIPT_PLACEHOLDERS);

export type ScriptValues = Record<AgencyScriptPlaceholder, string | null>;

/** `text` with its known placeholders filled from `valueOf` (nothing for a null), unknown ones kept. */
export function fillScriptPlaceholders(text: string, valueOf: (placeholder: AgencyScriptPlaceholder) => string | null): string {
  return text.replace(PLACEHOLDER, (whole, name: string) =>
    KNOWN.has(name) ? (valueOf(name as AgencyScriptPlaceholder) ?? '') : whole,
  );
}

/** A line filled with {@link ScriptValues}. */
export function fillScript(text: string, values: ScriptValues): string {
  return fillScriptPlaceholders(text, (p) => values[p]);
}

/** The agent's first name, for `{agent_name}`. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** What the placeholders say for the customer on screen. */
export function scriptValuesFor(
  attempt: AgencyReservedAttempt,
  card: { name: string | null; place: string | null },
  session: { agentName: string | null | undefined; campaignName: string | null | undefined },
): ScriptValues {
  const tiles = attempt.facts ? factTilesInOrder(attempt.facts) : [];
  const role = (r: 'amount_due' | 'due_date') => {
    const tile = tiles.find((t) => t.role === r);
    return tile ? factText(tile) : null;
  };
  const campaign = session.campaignName?.trim();
  return {
    name: card.name,
    place: card.place,
    amount_due: role('amount_due'),
    due_date: role('due_date'),
    agent_name: firstName(session.agentName),
    campaign_name: campaign ? campaign : null,
  };
}

/** The script with nothing in it reads as none (04c): no opening and no steps. */
export function scriptOrNone(script: AgencyAgentScript | undefined): { opening: string | null; steps: string[] } | null {
  const opening = script?.opening?.trim() || null;
  const steps = (script?.steps ?? []).map((s) => s.text.trim()).filter((t) => t !== '');
  if (opening === null && steps.length === 0) return null;
  return { opening, steps };
}
