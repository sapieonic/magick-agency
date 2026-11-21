/**
 * The campaign's script for its agents (agent station redesign, BE-8): `agency_campaigns.agent_script`
 * (JSONB, 0056, `AgencyAgentScript`), its rules at the campaign-config write, and its reading for
 * the session bootstrap (`AgencySessionBootstrap.script`). Pure.
 *
 * ── The write ({@link agentScriptIssues}) ───────────────────────────────────
 * An object with at most `opening` (1 to `AGENCY_SCRIPT_OPENING_MAX_CHARS` characters after
 * trimming) and `steps` (0 to `AGENCY_SCRIPT_STEPS_MAX` objects `{ text }`, each 1 to
 * `AGENCY_SCRIPT_STEP_MAX_CHARS` characters after trimming); any other key is refused. `{}` is the
 * empty script and clears it. Characters are Unicode code points, so a script in Hindi or Telugu
 * has the same room as one in English. The PATCH stores the texts trimmed
 * ({@link normalizeAgentScript}).
 *
 * ── Its keys, per campaign (AS19) ───────────────────────────────────────────
 * A `{word}` in braces (the domain's one reading, `@magick-agency/domain/fact-fields`) must be one
 * of the campaign's keys, spelled exactly: an unknown one would reach the agent as the literal
 * braces. The keys are `scriptPlaceholdersFor` the campaign's RESULTING `context_display` (the
 * body's when it carries one, since a write replaces the whole column, else the stored one): with
 * `facts`, `AGENCY_SCRIPT_FIXED_PLACEHOLDERS` and every fact's key; without, the legacy six
 * `AGENCY_SCRIPT_PLACEHOLDERS`. Both ways ({@link agentScriptIssues}):
 *  - a body that carries `agent_script` is refused for an unknown key, naming it, on the text's
 *    own field (with `facts`: "The script uses {branch}, which is not a fact on the card. …";
 *    without, the BE-8 wording, listing the six);
 *  - a body that carries `context_display` and not `agent_script` is refused, on
 *    `context_display.facts`, when it takes away a key the STORED script uses ("The script uses
 *    {due_date}. Take it out of the script first, or keep the fact."). Only a key the stored
 *    display allowed counts: a stored script that already named an unknown key does not block an
 *    edit of the card;
 *  - a body carrying both is checked as the pair: the new script against the new display.
 * The public layer holds no stored campaign, so it checks the keys only when the body carries
 * `context_display` (base `null`); the internal handler checks every body against the stored row.
 * A key with no value for a customer is shown by the clients as "<label> not given".
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
import { placeholdersIn, scriptPlaceholdersFor, unknownPlaceholdersIn } from '@magick-agency/domain/fact-fields';

/** One refusal, keyed by the body's field path (the campaign-config validators' shape). */
export interface AgentScriptIssue {
  field: string;
  message: string;
}

const FIELD = 'agent_script';

/**
 * What the keys are judged against: the stored campaign's display and script (a PATCH, a retry's
 * parent), `{}` on a create (no display: the legacy six; no script), or `null` where the stored
 * campaign is not known (the public layer).
 */
export interface AgentScriptBase {
  context_display?: unknown;
  agent_script?: unknown;
}

/** The keys a write is judged against, and whether they are a `facts` campaign's (AS19). */
interface ScriptKeys {
  keys: readonly string[];
  facts: boolean;
}

/** Length in Unicode code points, as the contract counts. */
const codePoints = (text: string): number => [...text].length;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The unknown `{word}`s a text names, braces included, each once, in order, against `allowed`
 * (default: the legacy six, a campaign without `facts`).
 */
export function unknownScriptPlaceholders(text: string, allowed: Iterable<string> = AGENCY_SCRIPT_PLACEHOLDERS): string[] {
  return unknownPlaceholdersIn(text, allowed);
}

/** `a`, `a and b`, `a, b and c`. */
function listed(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The keys a display allows (`scriptPlaceholdersFor`), and whether it is a `facts` display. */
function keysOf(display: unknown): ScriptKeys {
  const shown = asRecord(display);
  return { keys: scriptPlaceholdersFor(shown), facts: Array.isArray(shown?.['facts']) };
}

/**
 * The keys a write is judged against: the campaign's resulting display's, or `null` when it is
 * not known (the public layer, with no `context_display` in the body).
 */
function resultingKeys(record: Record<string, unknown>, base: AgentScriptBase | null): ScriptKeys | null {
  if (record['context_display'] !== undefined) return keysOf(record['context_display']);
  return base === null ? null : keysOf(base.context_display);
}

function placeholderIssue(text: string, field: string, allowed: ScriptKeys | null): AgentScriptIssue[] {
  if (allowed === null) return [];
  const unknown = unknownScriptPlaceholders(text, allowed.keys);
  if (unknown.length === 0) return [];
  if (allowed.facts) {
    return [{
      field,
      message: unknown.length === 1
        ? `The script uses ${unknown[0]}, which is not a fact on the card. Add it as a fact or take it out.`
        : `The script uses ${listed(unknown)}, which are not facts on the card. Add them as facts or take them out.`,
    }];
  }
  return [{
    field,
    message: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a word' : 'are not words'} the script can fill in. Use only: ${AGENCY_SCRIPT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`,
  }];
}

/** One text (the opening or a step) against its bound and the campaign's keys. */
function textIssues(value: unknown, field: string, max: number, what: string, allowed: ScriptKeys | null): AgentScriptIssue[] {
  if (typeof value !== 'string') return [{ field, message: `${what} must be text.` }];
  const length = codePoints(value.trim());
  if (length < 1 || length > max) return [{ field, message: `${what} must be 1 to ${max} characters.` }];
  return placeholderIssue(value, field, allowed);
}

/** Every text of a stored script, read leniently: the opening, then each step's. */
function scriptTexts(stored: unknown): string[] {
  const script = asRecord(stored);
  if (!script) return [];
  const texts: string[] = [];
  if (typeof script['opening'] === 'string') texts.push(script['opening']);
  if (Array.isArray(script['steps'])) {
    for (const step of script['steps']) {
      const text = asRecord(step)?.['text'];
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

/**
 * A `context_display` write that takes away a key the stored script uses (AS19): refused on
 * `context_display.facts`, naming the keys. Only when the body does not carry the script too (the
 * pair is then judged as the script), and only keys the stored display allowed.
 */
function lostKeyIssues(record: Record<string, unknown>, base: AgentScriptBase | null): AgentScriptIssue[] {
  if (base === null || record['context_display'] === undefined || record[FIELD] !== undefined) return [];
  const before = new Set(keysOf(base.context_display).keys);
  const after = new Set(keysOf(record['context_display']).keys);
  const lost: string[] = [];
  for (const text of scriptTexts(base.agent_script)) {
    for (const token of placeholdersIn(text)) {
      const key = token.slice(1, -1);
      if (before.has(key) && !after.has(key) && !lost.includes(token)) lost.push(token);
    }
  }
  if (lost.length === 0) return [];
  return [{
    field: 'context_display.facts',
    message: lost.length === 1
      ? `The script uses ${lost[0]}. Take it out of the script first, or keep the fact.`
      : `The script uses ${listed(lost)}. Take them out of the script first, or keep the facts.`,
  }];
}

/**
 * `agent_script` at the campaign-config write, and the script's keys against the campaign's
 * resulting `context_display` both ways; nothing when the body carries neither. Every issue, not
 * the first. See the module header.
 *
 * @param base the stored campaign's `context_display` and `agent_script` (`{}` on a create), or
 *             `null` where the stored campaign is not known (the public layer)
 */
export function agentScriptIssues(record: Record<string, unknown>, base: AgentScriptBase | null = {}): AgentScriptIssue[] {
  if (record[FIELD] === undefined) return lostKeyIssues(record, base);
  const allowed = resultingKeys(record, base);
  const script = asRecord(record[FIELD]);
  if (!script) {
    return [{ field: FIELD, message: 'The script must have an opening line and steps. Leave both empty for no script.' }];
  }
  const issues: AgentScriptIssue[] = [];
  for (const key of Object.keys(script)) {
    if (key !== 'opening' && key !== 'steps') {
      issues.push({ field: `${FIELD}.${key}`, message: 'A script has only an opening line and steps.' });
    }
  }
  if (script['opening'] !== undefined) {
    issues.push(...textIssues(script['opening'], `${FIELD}.opening`, AGENCY_SCRIPT_OPENING_MAX_CHARS, 'The opening line', allowed));
  }
  const steps = script['steps'];
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      issues.push({ field: `${FIELD}.steps`, message: 'The steps must be a list, one step after another.' });
    } else {
      if (steps.length > AGENCY_SCRIPT_STEPS_MAX) {
        issues.push({ field: `${FIELD}.steps`, message: `A script can have at most ${AGENCY_SCRIPT_STEPS_MAX} steps.` });
      }
      steps.forEach((raw, i) => {
        const at = `${FIELD}.steps[${i}]`;
        const step = asRecord(raw);
        if (!step) {
          issues.push({ field: at, message: `Step ${i + 1} must have its words.` });
          return;
        }
        for (const key of Object.keys(step)) {
          if (key !== 'text') issues.push({ field: `${at}.${key}`, message: `Step ${i + 1} can have only its words.` });
        }
        issues.push(...textIssues(step['text'], `${at}.text`, AGENCY_SCRIPT_STEP_MAX_CHARS, `Step ${i + 1}`, allowed));
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
