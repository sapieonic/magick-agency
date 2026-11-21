import { scriptPieces, scriptPlaceholdersFor } from '@magick-agency/domain/fact-fields';
import { AGENCY_SCRIPT_PLACEHOLDERS } from '../../types/agency';
import type { AgencyAgentScript, AgencyContextDisplay, AgencyReservedAttempt } from '../../types/agency';
import { factDisplay, factsChosen, factText, factTilesInOrder, tileName } from './stationCustomer';

/**
 * The campaign's script on the call screens (BE-8; AS2: no AI): "First, say this" on Call coming
 * (03) and "What to say" on On call (04), each line filled for the customer on screen.
 *
 * ── The fill rule (the contract's, `agent-script.ts`) ────────────────────────
 * A script is read by the domain's one reading of braces (`scriptPieces`, the server's own): a
 * `{key}` the campaign allows is replaced by its value; any other `{word}` is left as written.
 *  - **With chosen facts** (AS19, `context_display.facts`): the allowed keys are `{name}`,
 *    `{place}`, `{agent_name}`, `{campaign_name}` and each fact's key (digits allowed: `{emi_2}`).
 *    A fact key is filled from the panel's tile carrying that `key` (an `amount_due` / `due_date`
 *    tile from an older server, by its role), written as the card writes it (`₹1,25,000`, `20 Nov`,
 *    a masked phone stays masked). A key with no value for this customer shows "<label> not given"
 *    in the muted style (`{ kind: 'missing' }`), and Read aloud skips it.
 *  - **Without** (a campaign not saved since AS19): the legacy six, `{amount_due}` and
 *    `{due_date}` from the role tiles; a key with no value is left out (the line still shows), as
 *    before.
 * The agent's first name; the work's name.
 */

/** A run of a filled line: text to say, or a key this customer has no value for. */
export type FilledPiece = { kind: 'text'; text: string } | { kind: 'missing'; text: string };

/** One filled line of the script. */
export interface FilledLine {
  pieces: FilledPiece[];
  /** The line as it reads on screen, "not given" included. */
  shown: string;
  /** The line as Read aloud says it: the "not given" runs skipped. */
  spoken: string;
}

/** What a script's keys say for the customer on screen. */
export interface ScriptFill {
  /** The keys the campaign's script may use. */
  allowed: readonly string[];
  /** A key's value, or null when this customer has none. */
  valueOf: (key: string) => string | null;
  /** A key's name for "<label> not given"; null on the legacy path (a missing value is left out). */
  labelOf: (key: string) => string | null;
}

/**
 * `text` with its known placeholders filled from `valueOf` (nothing for a null), unknown ones
 * kept: the legacy fill, as the app's `fillScriptPlaceholders`.
 */
export function fillScriptPlaceholders(
  text: string,
  valueOf: (placeholder: string) => string | null,
  allowed: readonly string[] = AGENCY_SCRIPT_PLACEHOLDERS,
): string {
  return fillScriptLine(text, { allowed, valueOf, labelOf: () => null }).shown;
}

/** A line filled with a {@link ScriptFill}. */
export function fillScriptLine(text: string, fill: ScriptFill): FilledLine {
  const pieces: FilledPiece[] = [];
  const push = (piece: FilledPiece) => {
    const prev = pieces[pieces.length - 1];
    if (piece.kind === 'text' && prev?.kind === 'text') prev.text += piece.text;
    else if (piece.text !== '') pieces.push(piece);
  };
  for (const piece of scriptPieces(text, fill.allowed)) {
    if (piece.kind === 'text') push({ kind: 'text', text: piece.text });
    else if (piece.kind === 'unknown') push({ kind: 'text', text: piece.token });
    else {
      const value = fill.valueOf(piece.key);
      if (value !== null && value.trim() !== '') push({ kind: 'text', text: value });
      else {
        const label = fill.labelOf(piece.key);
        if (label !== null) push({ kind: 'missing', text: `${label} not given` });
      }
    }
  }
  const shown = pieces.map((p) => p.text).join('');
  const spoken = pieces
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { pieces, shown, spoken };
}

/** The agent's first name, for `{agent_name}`. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** How the fixed keys are named in "<label> not given" (the contract's: "Name", "Place"). */
const FIXED_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  place: 'Place',
  agent_name: 'Your name',
  campaign_name: 'Campaign name',
};

/** What the script's keys say for the customer on screen. */
export function scriptFillFor(
  attempt: Pick<AgencyReservedAttempt, 'facts'>,
  card: { name: string | null; place: string | null },
  session: { agentName: string | null | undefined; campaignName: string | null | undefined },
  display: AgencyContextDisplay | undefined,
  options: { phoneDisplay?: 'full' | 'masked'; now?: Date | number } = {},
): ScriptFill {
  const campaign = session.campaignName?.trim() || null;
  const fixed: Record<string, string | null> = {
    name: card.name,
    place: card.place,
    agent_name: firstName(session.agentName),
    campaign_name: campaign,
  };
  const tiles = attempt.facts?.tiles ?? [];

  if (!factsChosen(attempt.facts, display)) {
    const ordered = attempt.facts ? factTilesInOrder(attempt.facts) : [];
    const role = (r: 'amount_due' | 'due_date') => {
      const tile = ordered.find((t) => t.role === r);
      return tile ? factText(tile) : null;
    };
    const values: Record<string, string | null> = { ...fixed, amount_due: role('amount_due'), due_date: role('due_date') };
    return { allowed: AGENCY_SCRIPT_PLACEHOLDERS, valueOf: (key) => values[key] ?? null, labelOf: () => null };
  }

  const allowed = scriptPlaceholdersFor(display ?? { facts: [] });
  // With an older panel whose tiles carry no keys, the keys the campaign's list names still fill.
  for (const tile of tiles) if (tile.key && !allowed.includes(tile.key)) allowed.push(tile.key);
  const tileFor = (key: string) =>
    tiles.find((t) => t.key === key)
    ?? (key === 'amount_due' || key === 'due_date' ? tiles.find((t) => t.key === undefined && t.role === key) : undefined);
  return {
    allowed,
    valueOf: (key) => {
      if (Object.hasOwn(fixed, key)) return fixed[key]!;
      const tile = tileFor(key);
      if (!tile) return null;
      const shown = factDisplay(tile, options);
      return shown.empty ? null : shown.text;
    },
    labelOf: (key) => {
      if (Object.hasOwn(FIXED_LABELS, key)) return FIXED_LABELS[key]!;
      const fact = display?.facts?.find((f) => f?.key === key);
      if (fact?.label?.trim()) return fact.label.trim();
      const tile = tileFor(key);
      return tile ? tileName(tile) : key;
    },
  };
}

/** The script with nothing in it reads as none (04c): no opening and no steps. */
export function scriptOrNone(script: AgencyAgentScript | undefined): { opening: string | null; steps: string[] } | null {
  const opening = script?.opening?.trim() || null;
  const steps = (script?.steps ?? []).map((s) => s.text.trim()).filter((t) => t !== '');
  if (opening === null && steps.length === 0) return null;
  return { opening, steps };
}
