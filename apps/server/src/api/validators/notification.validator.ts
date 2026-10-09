import { z } from 'zod';
import {
  findNotificationEvent,
  isNotificationChannel,
  NOTIFICATION_CHANNELS,
} from '../../notifications/engine/catalog.js';
import { DIGEST_FREQUENCIES } from '../../notifications/engine/period.js';

/**
 * Preference writes, validated against the FROZEN catalog rather than against a
 * schema that restates it.
 *
 * The catalog is the single definition of which events exist, which are digests
 * and what a digest's default cadence is. A Zod enum listing the keys here would
 * be a second copy that has to be edited in lockstep — and the copy that drifts
 * is the one no request exercises, so the failure surfaces as a settings page
 * that silently refuses a toggle nobody can explain.
 *
 * `superRefine` therefore consults `findNotificationEvent` at validation time.
 * Every refusal names the offending value and the valid set, which matters more
 * than usual here: `errorMaskHook` passes a 4xx through UNCHANGED only when it
 * carries field-level `details`, so a bare message would reach the customer as
 * "contact support and quote this request id" for what is a typo in a checkbox.
 */

const frequencySchema = z.enum(DIGEST_FREQUENCIES);

const preferenceEntrySchema = z.object({
  event_key: z.string().min(1).max(100),
  /**
   * Optional, defaulting to the only channel there is.
   *
   * Present in the contract from the start rather than added later: a client
   * that has always sent `channel` keeps working when a second one exists, while
   * one that never sent it would need a coordinated change on the day the column
   * stops having a single possible value.
   */
  channel: z.string().min(1).max(30).default('email'),
  enabled: z.boolean(),
  /**
   * Nullable AND optional, and the two are different.
   *
   * Omitted on a digest event means "keep the default cadence"; explicit `null`
   * means the same thing, and is what a client sends when it clears a select.
   * Both resolve below, so a digest preference can never be stored with no
   * cadence at all — that row would leave a user `enabled` on the settings page
   * while matching no scheduled run, which is the one failure that looks like it
   * is working.
   */
  frequency: frequencySchema.nullable().optional(),
});

export const updateNotificationPreferencesSchema = z.object({
  preferences: z.array(preferenceEntrySchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();

  value.preferences.forEach((entry, index) => {
    const event = findNotificationEvent(entry.event_key);

    if (!event) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferences', index, 'event_key'],
        message: `Unknown notification event "${entry.event_key}"`,
      });
      return;
    }

    if (!isNotificationChannel(entry.channel)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferences', index, 'channel'],
        message: `Unsupported channel "${entry.channel}". Supported: ${NOTIFICATION_CHANNELS.join(', ')}`,
      });
      return;
    }

    // A duplicate is refused rather than last-write-wins. The upsert would
    // happily apply both in array order, so the stored value would depend on
    // which entry the client happened to put last — a silently non-deterministic
    // save is worse than a 400 naming the repeated key.
    const identity = `${entry.event_key}:${entry.channel}`;
    if (seen.has(identity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferences', index, 'event_key'],
        message: `Duplicate preference for "${entry.event_key}" on channel "${entry.channel}"`,
      });
      return;
    }
    seen.add(identity);

    // A frequency on an immediate event is refused, not ignored. Accepting and
    // dropping it leaves the client believing it set something; the column would
    // read NULL and the settings page would show a cadence the server does not
    // hold.
    if (event.cadence !== 'digest' && entry.frequency != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferences', index, 'frequency'],
        message: `"${entry.event_key}" is not a digest and takes no frequency`,
      });
    }
  });
});

export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

// No digest preview or digest-run schemas: there is no usage digest in v1.
// `DIGEST_FREQUENCIES` stays: the preference write still takes a `frequency`
// field (a non-null one is refused on every agency event, since none is a
// digest).
