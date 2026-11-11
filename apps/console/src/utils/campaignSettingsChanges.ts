import type { CampaignConfigState } from './agencyCampaignConfigForm';
import type { CampaignRecordingState } from './agencyCampaignRecording';
import { sameCarrier, type CarrierChoice } from './agencyCarriers';

/**
 * Everything the campaign Settings form holds, as of the last load or save (the baseline) or
 * as on screen now. The unsaved-changes bar counts the settings that differ between the two.
 */
export interface CampaignSettingsForm {
  name: string;
  callerIds: readonly string[];
  carrier: CarrierChoice;
  recording: CampaignRecordingState;
  config: CampaignConfigState;
}

/** Whether two caller-ID pools hold the same numbers (the picker appends, so order is incidental). */
export function samePool(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((n) => b.includes(n));
}

/**
 * Config keys that are not a setting someone edits: the stored abandonment ceiling is kept
 * beside the edited one only to remember what was stored.
 */
const NOT_A_SETTING = new Set<string>(['abandonmentCeilingStoredPct']);

/** Config groups whose fields are each a setting of their own on the page. */
const GROUPED = new Set<string>(['window', 'assignment']);

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  ));
}

/** Calling days are a set: ticking Tuesday off and on again is no change. */
function sameValue(path: string, a: unknown, b: unknown): boolean {
  if (path === 'window.days' && Array.isArray(a) && Array.isArray(b)) {
    return stable([...a].sort()) === stable([...b].sort());
  }
  return stable(a) === stable(b);
}

/**
 * The settings that differ between the saved form and the one on screen, one entry per
 * setting a person would name: the campaign name, the caller IDs, the carrier, recording, the
 * call summary, each calling-window field, wrap-up time, the retry policy, the outcome
 * catalogue (as a whole: editing three outcomes is one change to it), and so on. Ordered as the
 * form is, for a stable count; empty when nothing would be saved.
 */
export function changedSettings(saved: CampaignSettingsForm, now: CampaignSettingsForm): string[] {
  const changed: string[] = [];
  if (saved.name !== now.name) changed.push('name');
  if (!sameCarrier(saved.carrier, now.carrier)) changed.push('carrier');
  if (!samePool(saved.callerIds, now.callerIds)) changed.push('callerIds');

  const keys = new Set([...Object.keys(saved.config), ...Object.keys(now.config)]);
  for (const key of keys) {
    if (NOT_A_SETTING.has(key)) continue;
    const a = (saved.config as unknown as Record<string, unknown>)[key];
    const b = (now.config as unknown as Record<string, unknown>)[key];
    if (GROUPED.has(key) && a && b && typeof a === 'object' && typeof b === 'object') {
      const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const field of fields) {
        const path = `${key}.${field}`;
        if (!sameValue(path, (a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field])) {
          changed.push(path);
        }
      }
    } else if (!sameValue(key, a, b)) {
      changed.push(key);
    }
  }

  if (saved.recording.record !== now.recording.record) changed.push('recording.record');
  if (saved.recording.profileId !== now.recording.profileId) changed.push('recording.profileId');
  return changed;
}
