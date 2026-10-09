/**
 * The digest cadence vocabulary. Reached by the catalog's `defaultFrequency`
 * type, `audience.ts`' stored-row fallback, the notification model and the
 * preference validator. No digest event, and no digest window arithmetic, exists
 * in this server today.
 */

/** The cadences a digest can be subscribed at. Order is display order. */
export const DIGEST_FREQUENCIES = ['daily', 'weekly'] as const;

export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export function isDigestFrequency(value: unknown): value is DigestFrequency {
  return typeof value === 'string' && (DIGEST_FREQUENCIES as readonly string[]).includes(value);
}
