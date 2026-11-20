/**
 * The campaign's script for its agents (agent station redesign, BE-8): an opening line ("First, say
 * this" on Call coming) and up to {@link AGENCY_SCRIPT_STEPS_MAX} numbered steps ("What to say" on
 * the call). Set on the campaign (`agency_campaigns.agent_script`, JSONB, 0056; the campaign wire
 * type's `agent_script`) and served on the session bootstrap (`AgencySessionBootstrap.script`),
 * because it is campaign-constant like `retry_context`. Which step the agent is on is the client's
 * state; the server never hears of it.
 *
 * ── Placeholders ────────────────────────────────────────────────────────────
 * The text may name {@link AGENCY_SCRIPT_PLACEHOLDERS} in braces (`{name}`, `{amount_due}`, …). The
 * client fills them from the panel's typed facts (`AgencyReservedAttempt.facts`, BE-6) and the
 * session (`{agent_name}`: the agent's own name; `{campaign_name}`: the bootstrap's) with its own
 * formatting (`₹12,500`, `20 Nov`). A placeholder with no value for this customer is replaced by
 * nothing and the step still shows. The campaign-config write refuses an unknown placeholder (any
 * `{word}` not in the list), a step or opening out of bounds, and more than
 * {@link AGENCY_SCRIPT_STEPS_MAX} steps. Plain text in any language the supervisor types, never
 * markup.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the contract's header.
 */

import type { AllListed } from '../primitives';

/** The most steps a script may hold. */
export const AGENCY_SCRIPT_STEPS_MAX = 12;

/** The most characters (Unicode code points, after trimming) one step may hold; at least 1. */
export const AGENCY_SCRIPT_STEP_MAX_CHARS = 200;

/** The most characters (Unicode code points, after trimming) the opening line may hold; at least 1 when set. */
export const AGENCY_SCRIPT_OPENING_MAX_CHARS = 300;

/** The names a script's text may use in braces (`{name}`). */
export type AgencyScriptPlaceholder = 'name' | 'place' | 'amount_due' | 'due_date' | 'agent_name' | 'campaign_name';

export const AGENCY_SCRIPT_PLACEHOLDERS = [
  'name',
  'place',
  'amount_due',
  'due_date',
  'agent_name',
  'campaign_name',
] as const satisfies readonly AgencyScriptPlaceholder[];

const _allPlaceholdersListed: AllListed<AgencyScriptPlaceholder, typeof AGENCY_SCRIPT_PLACEHOLDERS> = true;
void _allPlaceholdersListed;

/** One numbered step of {@link AgencyAgentScript}. */
export interface AgencyAgentScriptStep {
  /** 1 to {@link AGENCY_SCRIPT_STEP_MAX_CHARS} characters, trimmed; may use placeholders. */
  text: string;
}

/**
 * A campaign's script. Both parts optional: a campaign with no script stores `{}` (the column
 * default), and a script may be an opening alone or steps alone. **No script** (`{}`, or no
 * opening and no steps) is what the bootstrap never carries: the station then shows the last calls
 * and a note on the call screen (`04c`).
 */
export interface AgencyAgentScript {
  /** "First, say this": 1 to {@link AGENCY_SCRIPT_OPENING_MAX_CHARS} characters, trimmed; may use placeholders. */
  opening?: string;
  /** "What to say", in order: 0 to {@link AGENCY_SCRIPT_STEPS_MAX} steps. */
  steps?: AgencyAgentScriptStep[];
}
