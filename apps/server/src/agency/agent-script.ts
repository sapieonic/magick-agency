/**
 * The campaign's script for its agents (agent station redesign, BE-8): `agency_campaigns.agent_script`
 * (JSONB, 0056, `AgencyAgentScript`), its rules at the campaign-config write, and its reading for
 * the session bootstrap (`AgencySessionBootstrap.script`). Pure.
 *
 * ── The write ({@link agentScriptIssues}) ───────────────────────────────────
 * An object with at most `opening` (1 to `AGENCY_SCRIPT_OPENING_MAX_CHARS` characters after
 * trimming) and `steps` (0 to `AGENCY_SCRIPT_STEPS_MAX` objects `{ text }`, each 1 to
 * `AGENCY_SCRIPT_STEP_MAX_CHARS` characters after trimming); any other key is refused. A `{word}`
 * in braces must be one of `AGENCY_SCRIPT_PLACEHOLDERS` (`{name}`, `{amount_due}`, …), spelled
 * exactly: an unknown one would reach the agent as the literal braces, so it is refused at the
 * write, naming it. `{}`
 * is the empty script and clears it. Characters are Unicode code points, so a script in Hindi or
 * Telugu has the same room as one in English. The PATCH stores the texts trimmed
 * ({@link normalizeAgentScript}).
 *
 * ── The read ({@link agentScriptForBootstrap}) ──────────────────────────────
 * The stored script as the station gets it, or `undefined` when the campaign has none (`{}`, or no
 * opening and no steps): the bootstrap then carries no `script` and the station shows its
 * no-script call screen. Read leniently: a part that is not well formed (a row written before the
 * write's rules, or by hand) is left out, never a failed join. Placeholders are filled by the
 * clients, not here.
 */
import {
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_PLACEHOLDERS,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  AGENCY_SCRIPT_STEPS_MAX,
  type AgencyAgentScript,
  type AgencyAgentScriptStep,
} from '@magick-agency/contracts/agency';

/** One refusal, keyed by the body's field path (the campaign-config validators' shape). */
export interface AgentScriptIssue {
  field: string;
  message: string;
}

const FIELD = 'agent_script';

/**
 * Every `{word}` in a text: one word of letters, digits and underscores in braces, spaces allowed
 * inside them. The clients fill `{name}` exactly (the app's `fillScriptPlaceholders` reads
 * `{[a-z_]+}`) and show anything else as typed, so `{Name}` or `{ name }` would reach the agent with
 * its braces: refused here as unknown. Braces round anything that is not one word are plain text.
 */
const BRACED = /\{\s*([A-Za-z0-9_]+)\s*\}/g;

const PLACEHOLDERS: ReadonlySet<string> = new Set(AGENCY_SCRIPT_PLACEHOLDERS);

/** Length in Unicode code points, as the contract counts. */
const codePoints = (text: string): number => [...text].length;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The unknown `{word}`s a text names, braces included, each once, in order. */
export function unknownScriptPlaceholders(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(BRACED)) {
    const word = match[0]!;
    if (!PLACEHOLDERS.has(word.slice(1, -1)) && !unknown.includes(word)) unknown.push(word);
  }
  return unknown;
}

function placeholderIssue(text: string, field: string): AgentScriptIssue[] {
  const unknown = unknownScriptPlaceholders(text);
  if (unknown.length === 0) return [];
  const named = unknown.join(', ');
  return [{
    field,
    message: `${named} ${unknown.length === 1 ? 'is not a word' : 'are not words'} the script can fill in. Use only: ${AGENCY_SCRIPT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
  }];
}

/** One text (the opening or a step) against its bound and the placeholders. */
function textIssues(value: unknown, field: string, max: number, what: string): AgentScriptIssue[] {
  if (typeof value !== 'string') return [{ field, message: `${what} must be text.` }];
  const length = codePoints(value.trim());
  if (length < 1 || length > max) return [{ field, message: `${what} must be 1 to ${max} characters.` }];
  return placeholderIssue(value, field);
}

/**
 * `agent_script` at the campaign-config write, or nothing when the body does not carry it. Every
 * issue, not the first. See the module header.
 */
export function agentScriptIssues(record: Record<string, unknown>): AgentScriptIssue[] {
  if (record[FIELD] === undefined) return [];
  const script = asRecord(record[FIELD]);
  if (!script) {
    return [{ field: FIELD, message: 'agent_script must be an object with an opening line and steps. Send {} for no script.' }];
  }
  const issues: AgentScriptIssue[] = [];
  for (const key of Object.keys(script)) {
    if (key !== 'opening' && key !== 'steps') {
      issues.push({ field: `${FIELD}.${key}`, message: `Unknown script field '${key}'. A script has only an opening line and steps.` });
    }
  }
  if (script['opening'] !== undefined) {
    issues.push(...textIssues(script['opening'], `${FIELD}.opening`, AGENCY_SCRIPT_OPENING_MAX_CHARS, 'The opening line'));
  }
  const steps = script['steps'];
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      issues.push({ field: `${FIELD}.steps`, message: 'steps must be a list of steps.' });
    } else {
      if (steps.length > AGENCY_SCRIPT_STEPS_MAX) {
        issues.push({ field: `${FIELD}.steps`, message: `A script can have at most ${AGENCY_SCRIPT_STEPS_MAX} steps.` });
      }
      steps.forEach((raw, i) => {
        const at = `${FIELD}.steps[${i}]`;
        const step = asRecord(raw);
        if (!step) {
          issues.push({ field: at, message: 'Each step must be an object with its text.' });
          return;
        }
        for (const key of Object.keys(step)) {
          if (key !== 'text') issues.push({ field: `${at}.${key}`, message: `Unknown step field '${key}'. A step has only its text.` });
        }
        issues.push(...textIssues(step['text'], `${at}.text`, AGENCY_SCRIPT_STEP_MAX_CHARS, `Step ${i + 1}`));
      });
    }
  }
  return issues;
}

/**
 * A script the write accepted, as it is stored: each text trimmed, an absent part left absent.
 * Anything else is returned unchanged (the validator has refused it already).
 */
export function normalizeAgentScript(value: unknown): unknown {
  const script = asRecord(value);
  if (!script) return value;
  const out: Record<string, unknown> = { ...script };
  if (typeof script['opening'] === 'string') out['opening'] = script['opening'].trim();
  if (Array.isArray(script['steps'])) {
    out['steps'] = script['steps'].map((step) => {
      const s = asRecord(step);
      return s && typeof s['text'] === 'string' ? { ...s, text: s['text'].trim() } : step;
    });
  }
  return out;
}

/**
 * The stored script as the bootstrap carries it, or `undefined` when the campaign has none.
 * Lenient: a part that is not well formed is left out. See the module header.
 */
export function agentScriptForBootstrap(stored: unknown): AgencyAgentScript | undefined {
  const script = asRecord(stored);
  if (!script) return undefined;
  const opening = typeof script['opening'] === 'string' && script['opening'].trim().length > 0
    ? script['opening'].trim()
    : undefined;
  const steps: AgencyAgentScriptStep[] = Array.isArray(script['steps'])
    ? script['steps']
      .map((s) => asRecord(s)?.['text'])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .slice(0, AGENCY_SCRIPT_STEPS_MAX)
      .map((text) => ({ text: text.trim() }))
    : [];
  if (opening === undefined && steps.length === 0) return undefined;
  return { ...(opening !== undefined ? { opening } : {}), ...(steps.length > 0 ? { steps } : {}) };
}
