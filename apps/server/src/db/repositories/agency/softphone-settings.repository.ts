/**
 * `AgencySoftphoneSettingsRepository`: `agency_softphone_settings`, one optional row
 * per (tenant, account) (0005, docs/softphone.md §3). No row reads as the defaults.
 *
 * The JSONB columns are CHECKed only as arrays (and `call_fields` to at most 20), so
 * their ELEMENTS are this file's to keep sound: {@link validateSoftphoneSettings}
 * refuses a malformed body before it is written, and the read path drops any element
 * that is not the shape the readers index into (a row written by hand or by an older
 * build must not 500 the soft phone's bootstrap).
 *
 * What it does NOT check, because it needs other tables: `default_caller_id` being
 * one of the account's assigned numbers, and `analysis_profile_id` naming a profile
 * of the account. The API layer checks both before `upsert`.
 */
import { getPool } from '@magick-agency/db';
import {
  AGENCY_CALL_FIELD_TYPES,
  SOFTPHONE_CALL_FIELD_KEY_MAX,
  SOFTPHONE_CALL_FIELD_KEY_PATTERN,
  SOFTPHONE_CALL_FIELD_RESERVED_KEYS,
  SOFTPHONE_CALL_FIELDS_MAX,
  type AgencyCallField,
  type AgencyDisposition,
  type AgencySoftphoneSettings,
  type AgencySoftphoneSettingsUpdateRequest,
} from '@magick-agency/contracts/agency';
import type { AgencySoftphoneSettingsRecord } from '../../models/agency.model.js';
// The campaign catalog's validator, reused so a soft-phone catalog is held to exactly
// the campaign's rules (code shape, uniqueness, label, flags, retry rule).
import { validateAgencyCampaignConfig } from '../../../agency/campaign-config.js';

/** One problem with a settings body: `path` into it and what is wrong (`settings_invalid`'s `details`). */
export interface SoftphoneSettingsIssue {
  path: string;
  message: string;
}

/** Thrown by {@link AgencySoftphoneSettingsRepository.upsert} for a body that fails {@link validateSoftphoneSettings}. */
export class SoftphoneSettingsInvalidError extends Error {
  constructor(readonly issues: SoftphoneSettingsIssue[]) {
    super('Soft-phone settings are invalid');
    this.name = 'SoftphoneSettingsInvalidError';
  }
}

/** What an account with no row reads as. */
export const SOFTPHONE_SETTINGS_DEFAULTS: Readonly<AgencySoftphoneSettings> = Object.freeze({
  disposition_catalog: [],
  call_fields: [],
  analysis_profile_id: null,
  record_calls: false,
  default_caller_id: null,
  updated_at: null,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_FIELD_LABEL_MAX = 100;
const CALL_FIELD_OPTION_MAX = 100;
/** The `default_caller_id` column is VARCHAR(20). */
const CALLER_ID_MAX = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Issues with one call field (`call_fields[i]`); empty when it is sound. */
function callFieldIssues(raw: unknown, at: string): SoftphoneSettingsIssue[] {
  if (!isRecord(raw)) return [{ path: at, message: 'Each call field must be an object.' }];
  const issues: SoftphoneSettingsIssue[] = [];
  const key = raw['key'];
  if (typeof key !== 'string' || key.length > SOFTPHONE_CALL_FIELD_KEY_MAX || !SOFTPHONE_CALL_FIELD_KEY_PATTERN.test(key)) {
    issues.push({
      path: `${at}.key`,
      message: `key must be snake_case, start with a letter, and be at most ${SOFTPHONE_CALL_FIELD_KEY_MAX} characters.`,
    });
  }
  const label = raw['label'];
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > CALL_FIELD_LABEL_MAX) {
    issues.push({ path: `${at}.label`, message: `label must be 1–${CALL_FIELD_LABEL_MAX} characters.` });
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !(AGENCY_CALL_FIELD_TYPES as readonly string[]).includes(type)) {
    issues.push({ path: `${at}.type`, message: `type must be one of ${AGENCY_CALL_FIELD_TYPES.join(', ')}.` });
  }
  const options = raw['options'];
  if (type === 'choice') {
    if (!Array.isArray(options) || options.length === 0) {
      issues.push({ path: `${at}.options`, message: 'A choice field needs at least one option.' });
    } else {
      const seen = new Set<string>();
      options.forEach((opt, i) => {
        if (typeof opt !== 'string' || opt.trim().length === 0 || opt.length > CALL_FIELD_OPTION_MAX) {
          issues.push({ path: `${at}.options[${i}]`, message: `Each option must be 1–${CALL_FIELD_OPTION_MAX} characters.` });
        } else if (seen.has(opt)) {
          issues.push({ path: `${at}.options[${i}]`, message: `Duplicate option '${opt}'.` });
        } else {
          seen.add(opt);
        }
      });
    }
  } else if (options !== undefined) {
    issues.push({ path: `${at}.options`, message: 'Only a choice field has options.' });
  }
  if (raw['required'] !== undefined && typeof raw['required'] !== 'boolean') {
    issues.push({ path: `${at}.required`, message: 'required must be a boolean.' });
  }
  return issues;
}

/**
 * Every problem with a `PUT /settings` body (docs/softphone.md §3), or none. Pure.
 *
 * - `disposition_catalog`: an array held to the campaign catalog's rules; `[]` is
 *   valid and means the built-in catalog.
 * - `call_fields`: at most `SOFTPHONE_CALL_FIELDS_MAX`, snake_case keys up to
 *   `SOFTPHONE_CALL_FIELD_KEY_MAX` characters, unique; a known type; `options` on a
 *   `choice` field only, distinct and non-empty.
 * - `analysis_profile_id`: a UUID or null (existence is the API layer's check).
 * - `record_calls`: boolean. `default_caller_id`: a non-empty string up to 20
 *   characters, or null (membership is the API layer's check).
 */
export function validateSoftphoneSettings(body: unknown): SoftphoneSettingsIssue[] {
  if (!isRecord(body)) return [{ path: '', message: 'Settings must be an object.' }];
  const issues: SoftphoneSettingsIssue[] = [];

  const catalog = body['disposition_catalog'];
  if (!Array.isArray(catalog)) {
    issues.push({ path: 'disposition_catalog', message: 'disposition_catalog must be an array.' });
  } else {
    for (const issue of validateAgencyCampaignConfig({ disposition_catalog: catalog })) {
      issues.push({ path: issue.field, message: issue.message });
    }
  }

  const fields = body['call_fields'];
  if (!Array.isArray(fields)) {
    issues.push({ path: 'call_fields', message: 'call_fields must be an array.' });
  } else {
    if (fields.length > SOFTPHONE_CALL_FIELDS_MAX) {
      issues.push({ path: 'call_fields', message: `At most ${SOFTPHONE_CALL_FIELDS_MAX} call fields.` });
    }
    const keys = new Set<string>();
    fields.forEach((raw, i) => {
      const at = `call_fields[${i}]`;
      issues.push(...callFieldIssues(raw, at));
      const key = isRecord(raw) ? raw['key'] : undefined;
      if (typeof key === 'string') {
        if (keys.has(key)) issues.push({ path: `${at}.key`, message: `Duplicate call field key '${key}'.` });
        // Refused at write only: `toSettings` still reads a stored one, and the
        // validator's own-property reads (`call-fields.ts`) keep it harmless.
        if (SOFTPHONE_CALL_FIELD_RESERVED_KEYS.has(key)) {
          issues.push({ path: `${at}.key`, message: `'${key}' is reserved; choose another key.` });
        }
        keys.add(key);
      }
    });
  }

  const profile = body['analysis_profile_id'];
  if (profile !== null && (typeof profile !== 'string' || !UUID_RE.test(profile))) {
    issues.push({ path: 'analysis_profile_id', message: 'analysis_profile_id must be a profile id or null.' });
  }
  if (typeof body['record_calls'] !== 'boolean') {
    issues.push({ path: 'record_calls', message: 'record_calls must be a boolean.' });
  }
  const callerId = body['default_caller_id'];
  if (callerId !== null && (typeof callerId !== 'string' || callerId.trim().length === 0 || callerId.length > CALLER_ID_MAX)) {
    issues.push({ path: 'default_caller_id', message: 'default_caller_id must be a phone number or null.' });
  }
  return issues;
}

/**
 * A stored row → the wire settings, dropping malformed JSONB elements rather than
 * failing the read: a catalog entry without a code, or a call field that is not the
 * shape the console and the field validator index into, is skipped. Mirrors
 * `resolveDisposition`'s defensive read of a campaign catalog.
 */
function toSettings(row: AgencySoftphoneSettingsRecord): AgencySoftphoneSettings {
  const catalog: AgencyDisposition[] = Array.isArray(row.disposition_catalog)
    ? row.disposition_catalog.filter((d): d is AgencyDisposition =>
      isRecord(d) && typeof d['code'] === 'string' && d['code'].length > 0 && typeof d['label'] === 'string')
    : [];
  const fields: AgencyCallField[] = Array.isArray(row.call_fields)
    ? row.call_fields.filter((f): f is AgencyCallField => callFieldIssues(f, '').length === 0)
    : [];
  return {
    disposition_catalog: catalog,
    call_fields: fields,
    analysis_profile_id: row.analysis_profile_id,
    record_calls: row.record_calls,
    default_caller_id: row.default_caller_id,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class AgencySoftphoneSettingsRepository {
  /**
   * The account's settings, as the wire shape: the defaults
   * ({@link SOFTPHONE_SETTINGS_DEFAULTS}, `updated_at: null`) when it has no row.
   * `disposition_catalog: []` still means the built-in catalog; resolving it is the
   * reader's (bootstrap's `untagged.disposition_catalog`, the outcome path).
   */
  async get(tenantId: string, accountId: string): Promise<AgencySoftphoneSettings> {
    const { rows } = await getPool().query<AgencySoftphoneSettingsRecord>(
      'SELECT * FROM agency_softphone_settings WHERE tenant_id = $1 AND account_id = $2',
      [tenantId, accountId],
    );
    const row = rows[0];
    return row ? toSettings(row) : { ...SOFTPHONE_SETTINGS_DEFAULTS };
  }

  /**
   * Replace the account's settings wholesale (`PUT /settings`), creating the row on
   * the first write: one `INSERT … ON CONFLICT (tenant_id, account_id) DO UPDATE`,
   * so two first writes cannot race into a 23505.
   *
   * @throws SoftphoneSettingsInvalidError when the body fails
   *   {@link validateSoftphoneSettings} — nothing is written. The API layer runs the
   *   validator first to answer `settings_invalid` with `details`; this is the
   *   backstop for any other writer.
   */
  async upsert(
    tenantId: string,
    accountId: string,
    settings: AgencySoftphoneSettingsUpdateRequest,
  ): Promise<AgencySoftphoneSettings> {
    const issues = validateSoftphoneSettings(settings);
    if (issues.length > 0) throw new SoftphoneSettingsInvalidError(issues);
    const { rows } = await getPool().query<AgencySoftphoneSettingsRecord>(
      `INSERT INTO agency_softphone_settings
         (tenant_id, account_id, disposition_catalog, call_fields,
          analysis_profile_id, record_calls, default_caller_id)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
       ON CONFLICT (tenant_id, account_id) DO UPDATE
         SET disposition_catalog = EXCLUDED.disposition_catalog,
             call_fields = EXCLUDED.call_fields,
             analysis_profile_id = EXCLUDED.analysis_profile_id,
             record_calls = EXCLUDED.record_calls,
             default_caller_id = EXCLUDED.default_caller_id
       RETURNING *`,
      [
        tenantId, accountId,
        JSON.stringify(settings.disposition_catalog),
        JSON.stringify(settings.call_fields),
        settings.analysis_profile_id,
        settings.record_calls,
        settings.default_caller_id,
      ],
    );
    return toSettings(rows[0]!);
  }
}

export const agencySoftphoneSettingsRepository = new AgencySoftphoneSettingsRepository();
