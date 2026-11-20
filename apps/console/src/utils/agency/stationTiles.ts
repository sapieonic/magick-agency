import type { AgencyBreakReason, AgencyDisposition } from '../../types/agency';

/**
 * The picture tiles' rules (spec §6.2 and §5.4–5.5), pure.
 *
 * Outcome tiles are the campaign's own `disposition_catalog`, **in the order the server sent it**
 * (never re-sorted: the number keys 1–9 are bound by index, and a sort would move every agent's
 * keys the moment someone renames an outcome).
 */

/** What each tile shows as its picture. A field on each outcome (BE-13) will replace the guess. */
export type OutcomeIcon = 'rupee' | 'clock' | 'stop' | 'thumbs_up' | 'no_voice' | 'refused' | 'wrong_number' | 'dot';

/**
 * The picture for an outcome. An `icon` sent by the server wins once it exists (BE-13, an optional
 * field the contract does not have yet); until then the flags decide, as the spec suggests
 * (`requires_promise` → ₹, `requires_datetime` → clock, `suppress` → stop, `is_success` → thumbs
 * up), then a few everyday labels, then a neutral dot.
 */
export function outcomeIcon(entry: AgencyDisposition & { icon?: string | null }): OutcomeIcon {
  const sent = entry.icon ?? null;
  if (sent && (OUTCOME_ICONS as readonly string[]).includes(sent)) return sent as OutcomeIcon;
  if (entry.suppress) return 'stop';
  if (entry.requires_promise) return 'rupee';
  if (entry.requires_datetime) return 'clock';
  if (entry.is_success) return 'thumbs_up';
  const label = entry.label.toLowerCase();
  if (/wrong|invalid|not .*(number|person)/.test(label)) return 'wrong_number';
  if (/refus|declin|not interested|denied/.test(label)) return 'refused';
  if (/no one|nobody|no answer|silent|voicemail|machine|did not speak|no response/.test(label)) return 'no_voice';
  return 'dot';
}

export const OUTCOME_ICONS: readonly OutcomeIcon[] = ['rupee', 'clock', 'stop', 'thumbs_up', 'no_voice', 'refused', 'wrong_number', 'dot'];

/** Tile size by how many outcomes the campaign has (§6.2): 1–6 big, 7 or more small. */
export type TileSize = 'big' | 'small';

export interface OutcomeTileLayout {
  size: TileSize;
  /** The tiles shown on the grid, in catalog order. */
  shown: AgencyDisposition[];
  /** Behind the More tile (10 or more outcomes); empty otherwise. */
  overflow: AgencyDisposition[];
  /**
   * The separate red "Don't call again" row under the tiles: only when no outcome on the list
   * stops calls itself (`suppress`), so there is always exactly one way to say it.
   */
  dontCallAgainRow: boolean;
}

/** Up to nine tiles fit; past that the first eight and a More tile. */
export const MAX_TILES_WITHOUT_MORE = 9;
export const TILES_BEFORE_MORE = 8;

export function outcomeTileLayout(catalog: readonly AgencyDisposition[]): OutcomeTileLayout {
  const size: TileSize = catalog.length <= 6 ? 'big' : 'small';
  const overflowing = catalog.length > MAX_TILES_WITHOUT_MORE;
  return {
    size,
    shown: overflowing ? catalog.slice(0, TILES_BEFORE_MORE) : [...catalog],
    overflow: overflowing ? catalog.slice(TILES_BEFORE_MORE) : [],
    dontCallAgainRow: !catalog.some((entry) => entry.suppress),
  };
}

/** The picture for a break reason: an `icon` once sent (BE-13), else a guess from the code and label, a cup by default. */
export type BreakIcon = 'cup' | 'meal' | 'washroom' | 'meeting' | 'training' | 'phone' | 'pause';

export function breakIcon(reason: Pick<AgencyBreakReason, 'code' | 'label'> & { icon?: string | null }): BreakIcon {
  const sent = reason.icon ?? null;
  if (sent && (BREAK_ICONS as readonly string[]).includes(sent)) return sent as BreakIcon;
  const text = `${reason.code} ${reason.label}`.toLowerCase();
  if (/lunch|dinner|meal|food|breakfast/.test(text)) return 'meal';
  if (/wash|toilet|rest ?room|bio|bathroom|loo/.test(text)) return 'washroom';
  if (/meet|huddle|brief/.test(text)) return 'meeting';
  if (/train|coach|learn|class/.test(text)) return 'training';
  if (/phone|soft/.test(text)) return 'phone';
  if (/tea|coffee|chai|snack|short/.test(text)) return 'cup';
  return 'cup';
}

export const BREAK_ICONS: readonly BreakIcon[] = ['cup', 'meal', 'washroom', 'meeting', 'training', 'phone', 'pause'];
