import { EMPTY_CAMPAIGN_CONFIG, validateConfig } from '../agencyCampaignConfigForm';
import { fieldsFromRows, rowsFromFields, validateCallFieldRows, type CallFieldRow } from './fieldSettings';
import type { AgencyDisposition } from '../../types/agency';
import type { AgencySoftphoneSettings, AgencySoftphoneSettingsUpdateRequest } from '../../types/softphone';

/**
 * Settings → Soft phone, as a form: the draft, the payload it saves as (`PUT
 * /settings` replaces the whole row), and the client half of `settings_invalid`.
 *
 * The outcome list reuses the campaign builder's catalog rules unchanged
 * (`validateConfig`'s `disposition_catalog[…]` findings), so an untagged outcome
 * is held to exactly what a campaign's is. `[]` is the built-in catalog, not "no
 * outcomes" (`AgencySoftphoneSettings.disposition_catalog`).
 */
export interface SoftphoneSettingsDraft {
  /** `[]` = the built-in outcomes. */
  catalog: AgencyDisposition[];
  fieldRows: CallFieldRow[];
  profileId: string | null;
  record: boolean;
  defaultCallerId: string | null;
}

export function draftFromSettings(settings: AgencySoftphoneSettings): SoftphoneSettingsDraft {
  return {
    catalog: settings.disposition_catalog.map((entry) => ({ ...entry, ...(entry.retry ? { retry: { ...entry.retry } } : {}) })),
    fieldRows: rowsFromFields(settings.call_fields),
    profileId: settings.analysis_profile_id,
    record: settings.record_calls,
    defaultCallerId: settings.default_caller_id,
  };
}

export function payloadFromDraft(draft: SoftphoneSettingsDraft): AgencySoftphoneSettingsUpdateRequest {
  return {
    disposition_catalog: draft.catalog,
    call_fields: fieldsFromRows(draft.fieldRows),
    analysis_profile_id: draft.profileId,
    record_calls: draft.record,
    default_caller_id: draft.defaultCallerId,
  };
}

export function validateSettingsDraft(draft: SoftphoneSettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.catalog.length > 0) {
    const catalogErrors = validateConfig({ ...EMPTY_CAMPAIGN_CONFIG, dispositions: draft.catalog });
    for (const [path, message] of Object.entries(catalogErrors)) {
      if (path.startsWith('disposition_catalog')) errors[path] = message;
    }
  }
  Object.assign(errors, validateCallFieldRows(draft.fieldRows));
  return errors;
}

/** `settings_invalid` details → errors by path. */
export function settingsErrorsFromDetails(details: Array<{ path: string; message: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { path, message } of details ?? []) out[path] = message;
  return out;
}

/** Whether the draft would save as something other than what is stored. */
export function settingsChanged(saved: AgencySoftphoneSettings, draft: SoftphoneSettingsDraft): boolean {
  const a = payloadFromDraft(draftFromSettings(saved));
  const b = payloadFromDraft(draft);
  return JSON.stringify(a) !== JSON.stringify(b);
}
