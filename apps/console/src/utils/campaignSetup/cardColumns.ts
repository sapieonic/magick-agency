import { maskFactPhone } from '@magick-agency/domain/fact-phone';
import type { AgencyColumnAnalysis } from '../../types/agency-campaign';
import {
  MAX_HERO_FIELDS,
  cardRoleColumns,
  setRole,
  type MappingState,
} from '../agencyColumnMapping';
import { SURE_PHONE_SHARE } from './ingestChips';

/**
 * Step 2's "Tick what goes on the customer card" (CS9): one switch per column of the
 * sample table, over the column mapper's own card roles, so the card saved is exactly what
 * `buildContextDisplay` builds from the mapping.
 *
 * The rule, kept as simple as the card's own (AS19):
 *  - The customer's name and the line under it are the columns the domain's one guess finds
 *    (`cardRoleColumns`, S1), among the columns the contact keeps. They are always on the card,
 *    so their switches are on and locked, saying which they are.
 *  - Every other kept column is a fact: its switch sets it "On the card" (the mapper's `hero`
 *    role) or back to Detail. Up to `MAX_HERO_FIELDS` (4, `AGENCY_FACT_FIELDS_MAX`), in the order
 *    ticked, which is the order the card draws them; when four are ticked the other switches are
 *    disabled and say why.
 *  - The phone number is always on the card, partly hidden (step 4 changes that); the timezone
 *    column sets the calling hours and an ignored column is left out of the contact, so none of
 *    the three has a switch to flip. "Change columns" (the full mapper) changes those roles.
 */

export type CardColumnKind = 'phone' | 'timezone' | 'ignored' | 'name' | 'place' | 'fact';

export interface CardColumn {
  name: string;
  kind: CardColumnKind;
  /** Whether the column is on the agent's card. */
  on: boolean;
  /** Only a fact's switch can be flipped, and only while there is room or it is on. */
  locked: boolean;
  /** Why the switch cannot be flipped, said beside it; null when it can. */
  lockedReason: string | null;
  /** A fact's place on the card (1-based, the order ticked), or null. */
  factNumber: number | null;
  /** Whether the preview hides most of each value: the phone column and any column of numbers. */
  masked: boolean;
}

/** Said on a fact's switch while the card is full. */
export const CARD_FULL_REASON = `The card shows ${MAX_HERO_FIELDS} facts at most. Untick one to show this instead.`;

const LOCKED_REASONS: Record<Exclude<CardColumnKind, 'fact'>, string> = {
  phone: 'Always shown, partly hidden',
  timezone: 'Used for calling hours',
  ignored: 'Left out of the upload',
  name: 'Shown as the customer’s name',
  place: 'Shown as the line under the name',
};

/** The facts picked, in order: the `hero` columns that are not the name or the line under it. */
export function cardFacts(mapping: MappingState): string[] {
  const { name, place } = cardRoleColumns(mapping);
  return mapping.heroOrder.filter((column) => column !== name && column !== place);
}

/** Whether the card holds as many facts as it can. */
export function cardIsFull(mapping: MappingState): boolean {
  return cardFacts(mapping).length >= MAX_HERO_FIELDS;
}

/** Whether a column's values look like phone numbers (the preview hides them). */
function phoneLike(stat: AgencyColumnAnalysis['columns'][number]): boolean {
  return stat.non_empty > 0 && stat.phone_score >= SURE_PHONE_SHARE;
}

/** Every column of the file, in file order, as the switches show it. */
export function cardColumns(analysis: AgencyColumnAnalysis, mapping: MappingState): CardColumn[] {
  const { name, place } = cardRoleColumns(mapping);
  const facts = cardFacts(mapping);
  const full = facts.length >= MAX_HERO_FIELDS;
  return analysis.columns.map((stat) => {
    const role = mapping.roles[stat.name] ?? 'detail';
    const kind: CardColumnKind =
      role === 'phone'
        ? 'phone'
        : role === 'timezone'
          ? 'timezone'
          : role === 'ignore'
            ? 'ignored'
            : stat.name === name
              ? 'name'
              : stat.name === place
                ? 'place'
                : 'fact';
    const masked = kind === 'phone' || phoneLike(stat);
    if (kind !== 'fact') {
      return {
        name: stat.name,
        kind,
        on: kind === 'phone' || kind === 'name' || kind === 'place',
        locked: true,
        lockedReason: LOCKED_REASONS[kind],
        factNumber: null,
        masked,
      };
    }
    const index = facts.indexOf(stat.name);
    const on = index >= 0;
    return {
      name: stat.name,
      kind,
      on,
      locked: !on && full,
      lockedReason: !on && full ? CARD_FULL_REASON : null,
      factNumber: on ? index + 1 : null,
      masked,
    };
  });
}

/**
 * Flip a fact's switch: on puts the column "On the card" after the facts already there; off sets
 * it back to Detail. A column that is not a fact, or a fifth fact, leaves the mapping unchanged.
 *
 * A name or line-under-name column that the full mapper put "On the card" holds a hero slot
 * without being a fact (it is drawn as the name or the line); turning a fact on first gives such
 * slots back, so the card can always hold four facts beside the name and the line.
 */
export function toggleCardColumn(mapping: MappingState, column: string, on: boolean): MappingState {
  const role = mapping.roles[column];
  if (role !== 'detail' && role !== 'hero') return mapping;
  const { name, place } = cardRoleColumns(mapping);
  if (column === name || column === place) return mapping;
  if (!on) return role === 'hero' ? setRole(mapping, column, 'detail') : mapping;
  if (role === 'hero') return mapping;
  if (cardIsFull(mapping)) return mapping;
  let next = mapping;
  for (const held of [name, place]) {
    if (held !== undefined && next.heroOrder.includes(held)) next = setRole(next, held, 'detail');
  }
  return setRole(next, column, 'hero');
}

/** The sample table's rows: the i-th sample of each column, up to `max` rows. */
export function sampleRows(analysis: AgencyColumnAnalysis, max = 3): string[][] {
  const depth = Math.min(max, Math.max(0, ...analysis.columns.map((c) => c.samples.length)));
  return Array.from({ length: depth }, (_, i) => analysis.columns.map((c) => c.samples[i] ?? ''));
}

/** A cell as the preview shows it: a phone-like column's value partly hidden (AS19 R6's mask). */
export function previewCell(value: string, masked: boolean): string {
  if (value === '') return '';
  return masked ? maskFactPhone(value) : value;
}

/**
 * The line above the table, saying what the card will show: "Name: Full Name · Under it: City ·
 * 2 of 4 facts". With nothing ticked, the card is left to the server's guess from the column
 * names (no `context_display` is saved), and the line says so.
 */
export function cardSummaryLine(mapping: MappingState): string {
  const { name, place } = cardRoleColumns(mapping);
  const facts = cardFacts(mapping);
  if (facts.length === 0) {
    return `Nothing ticked yet: the card shows what we can tell from the column names. Tick up to ${MAX_HERO_FIELDS} columns to choose.`;
  }
  const parts = [
    ...(name ? [`Name: ${name}`] : []),
    ...(place ? [`Under it: ${place}`] : []),
    `${facts.length} of ${MAX_HERO_FIELDS} facts`,
  ];
  return parts.join(' · ');
}
