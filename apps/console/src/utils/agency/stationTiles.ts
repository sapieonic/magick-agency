import { isTileIconKey, type TileIconKey } from '@magick-agency/web-ui/components/TileIcon';
import type { AgencyBreakReason, AgencyDisposition } from '../../types/agency';

/**
 * The picture tiles' rules (spec §6.2 and §5.4–5.5), pure.
 *
 * Outcome tiles are the campaign's own `disposition_catalog`, **in the order the server sent it**
 * (never re-sorted: the number keys 1–9 are bound by index, and a sort would move every agent's
 * keys the moment someone renames an outcome).
 */

/**
 * What each tile shows as its picture: one of the shared tile pictures (`TileIcon` in
 * `packages/web-ui`, the keys of the contract's `AGENCY_TILE_ICONS`), so an agent sees exactly
 * what the supervisor picked in campaign Settings; or, for a guess with no shared picture, the
 * station's own `no_voice`.
 */
export type OutcomeIcon = TileIconKey | 'no_voice';

/**
 * The picture for an outcome. The `icon` the supervisor picked wins (BE-13); a stray stored value
 * draws as no pick. With none, the flags decide, as the spec suggests (`suppress` → stop,
 * `requires_promise` → ₹, `requires_datetime` → clock, `is_success` → thumbs up), then a few
 * everyday labels, then a neutral dot.
 */
export function outcomeIcon(entry: Pick<AgencyDisposition, 'label' | 'suppress' | 'requires_promise' | 'requires_datetime' | 'is_success'> & { icon?: string | null }): OutcomeIcon {
  if (isTileIconKey(entry.icon)) return entry.icon;
  if (entry.suppress) return 'stop';
  if (entry.requires_promise) return 'rupee';
  if (entry.requires_datetime) return 'clock';
  if (entry.is_success) return 'thumbs_up';
  const label = entry.label.toLowerCase();
  if (/wrong|invalid|not .*(number|person)/.test(label)) return 'wrong_number';
  if (/refus|declin|not interested|denied/.test(label)) return 'thumbs_down';
  if (/no one|nobody|no answer|silent|voicemail|machine|did not speak|no response/.test(label)) return 'no_voice';
  return 'dot';
}

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

/** The picture for a break reason: a shared tile picture, or the station's own `phone` (the soft phone). */
export type BreakIcon = TileIconKey | 'phone';

/** The supervisor's pick (BE-13) when sent; else a guess from the code and label, a cup of tea by default. */
export function breakIcon(reason: Pick<AgencyBreakReason, 'code' | 'label'> & { icon?: string | null }): BreakIcon {
  if (isTileIconKey(reason.icon)) return reason.icon;
  const text = `${reason.code} ${reason.label}`.toLowerCase();
  if (/lunch|dinner|meal|food|breakfast/.test(text)) return 'lunch';
  if (/wash|toilet|rest ?room|bio|bathroom|loo/.test(text)) return 'washroom';
  if (/meet|huddle|brief/.test(text)) return 'meeting';
  if (/train|coach|learn|class/.test(text)) return 'training';
  if (/pray|namaz|puja/.test(text)) return 'prayer';
  if (/phone|soft/.test(text)) return 'phone';
  return 'tea';
}
