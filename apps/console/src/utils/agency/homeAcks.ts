import type { HomeAttentionItem, HomeTone } from './home';
import { zoneDay } from './insights/range';

/**
 * Home's "Got it" (decision B28a, acknowledgements): a reader can put an attention row aside, so
 * one overdue callback does not keep the badge lit all day and teach people to ignore it. Pure;
 * the store is `hooks/useHomeAcks.ts`.
 *
 *  - **Per viewer**, per tenant and account, in this browser only. Nobody else's Home changes.
 *  - **Until it gets worse**: a row stays aside while its kind (the stall's code, the rule) and
 *    its tone are the same and its count has not grown. A count that falls stays aside; a new
 *    kind, another tone or a higher count brings the row back, and back onto the badge.
 *  - **Until tomorrow**: every acknowledgement is dropped at the next calendar day in
 *    {@link HOME_ACK_ZONE}, the zone the console's day-based reads use.
 *  - **Nothing is lost**: acknowledged rows are listed behind a "N acknowledged · Show" toggle.
 */

/** The calendar the acknowledgements' day is kept in. */
export const HOME_ACK_ZONE = 'Asia/Kolkata';

/** What a "Got it" remembers of the row. */
export interface HomeAck {
  kind: string;
  tone: HomeTone;
  /** The row's count when it was put aside; null for a row that counts nothing. */
  count: number | null;
}

/** One tenant and account's acknowledgements, as stored. */
export interface HomeAckRecord {
  /** `YYYY-MM-DD` in {@link HOME_ACK_ZONE}: the day they were made. */
  day: string;
  /** By the row's id (stable across refreshes: the condition and its campaign). */
  acks: Record<string, HomeAck>;
}

/** Today, for the acknowledgements. */
export function homeAckDay(now: Date): string {
  return zoneDay(HOME_ACK_ZONE, now);
}

/** What to remember of a row when it is put aside. */
export function ackOf(item: Pick<HomeAttentionItem, 'kind' | 'tone' | 'count'>): HomeAck {
  return { kind: item.kind, tone: item.tone, count: item.count };
}

/** Whether a row is still aside under `ack`: same kind and tone, and no more of it. */
export function stillAcknowledged(
  item: Pick<HomeAttentionItem, 'kind' | 'tone' | 'count'>,
  ack: HomeAck | undefined,
): boolean {
  if (!ack || ack.kind !== item.kind || ack.tone !== item.tone) return false;
  if (ack.count === null || item.count === null) return ack.count === item.count;
  return item.count <= ack.count;
}

/** Today's acknowledgements from what was stored: none from another day or from anything unreadable. */
export function todaysAcks(stored: unknown, today: string): Record<string, HomeAck> {
  if (!stored || typeof stored !== 'object') return {};
  const record = stored as Partial<HomeAckRecord>;
  if (record.day !== today || !record.acks || typeof record.acks !== 'object') return {};
  const out: Record<string, HomeAck> = {};
  for (const [id, ack] of Object.entries(record.acks)) {
    if (!ack || typeof ack !== 'object') continue;
    const { kind, tone, count } = ack as Partial<HomeAck>;
    if (typeof kind !== 'string' || (tone !== 'danger' && tone !== 'warning' && tone !== 'info')) continue;
    if (count !== null && (typeof count !== 'number' || !Number.isFinite(count))) continue;
    out[id] = { kind, tone, count };
  }
  return out;
}

/** The rows still to show, and the ones the reader put aside, each in the list's order. */
export function splitAcknowledged<T extends Pick<HomeAttentionItem, 'id' | 'kind' | 'tone' | 'count'>>(
  items: readonly T[],
  acks: Readonly<Record<string, HomeAck>>,
): { open: T[]; acknowledged: T[] } {
  const open: T[] = [];
  const acknowledged: T[] = [];
  for (const item of items) (stillAcknowledged(item, acks[item.id]) ? acknowledged : open).push(item);
  return { open, acknowledged };
}
