/**
 * The soft phone's outcome rules (docs/softphone.md §4.1 step 7, §5): which catalog
 * a call is dispositioned against, the submitted outcome validated with the
 * station's own pure functions, and the roster decision it implies. Pure; the
 * service owns the transaction (`recordDisposition` → DNC → `settleFromManual`).
 */
import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  type AgencyCallField,
  type AgencyCallFieldValues,
  type AgencyDisposition,
  type AgencyManualCallDispositionSource,
  type AgencySoftphoneSettings,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../db/models/agency.model.js';
import { resolveDisposition, validateDispositionFields } from '../disposition.js';
import { resolveDispositionDecision, type DispositionDecision } from '../disposition-policy.js';
import { resolveCallingWindow, scheduleCallbackInWindow } from '../calling-hours.js';
import { storedValuesInForce, submittedCallFields, validateCallFieldValues } from './call-fields.js';
import type { SoftphoneRefusal } from './types.js';

function nonEmpty(catalog: unknown): catalog is AgencyDisposition[] {
  return Array.isArray(catalog) && catalog.length > 0;
}

/**
 * The catalog a call's outcome resolves against, and the `disposition_source` it
 * is stored with: a tagged call uses the campaign's `disposition_catalog`; an
 * untagged one the settings' catalog, else the built-in.
 *
 * A tagged campaign whose catalog is EMPTY (or whose row is gone) falls back to the
 * built-in catalog, still as source `campaign`. On the station an empty catalog
 * means "no write-up step", but a soft-phone call that bridged always owes an
 * outcome (`requires_disposition`), and a catalog with no codes would leave it
 * unsavable until the lapse.
 */
export function resolveManualCatalog(
  tag: Pick<AgencyCampaignRecord, 'disposition_catalog'> | null,
  tagged: boolean,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): { catalog: AgencyDisposition[]; source: AgencyManualCallDispositionSource } {
  if (tagged) {
    return {
      catalog: nonEmpty(tag?.disposition_catalog) ? tag!.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
      source: 'campaign',
    };
  }
  return {
    catalog: nonEmpty(settings.disposition_catalog) ? settings.disposition_catalog : [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
    source: 'softphone',
  };
}

/** A submitted outcome, validated: the catalog entry, notes, callback and the fields to store. */
export interface PreparedManualDisposition {
  entry: AgencyDisposition;
  notes: string | null;
  callbackAt: Date | null;
  /** Present when the request carried `fields` (they replace the stored values). */
  fields: AgencyCallFieldValues | undefined;
}

/**
 * Validate a submitted outcome: the code against `catalog` (`resolveDisposition`),
 * its note / callback against the entry (`validateDispositionFields`), and the call
 * fields against the field set in force WITH `required` enforced — on the submitted
 * values when the request carries them, else on the stored ones (those of fields
 * still in force: `storedValuesInForce`). Omitted `fields`, and `{}` while no call
 * fields are in force, leave the stored values unchanged (`submittedCallFields`).
 */
export function prepareManualDisposition(input: {
  catalog: AgencyDisposition[];
  code: unknown;
  notes?: unknown;
  callbackAt?: unknown;
  callFields: readonly AgencyCallField[];
  submittedFields: unknown;
  storedFields: AgencyCallFieldValues;
  now: Date;
}): { ok: true; prepared: PreparedManualDisposition } | { ok: false; refusal: SoftphoneRefusal } {
  const resolved = resolveDisposition(input.catalog, input.code);
  if (!resolved.ok) {
    return { ok: false, refusal: { code: 'disposition_invalid', reason: 'unknown_code', allowed_codes: resolved.allowed } };
  }
  const fields = validateDispositionFields(resolved.entry, { notes: input.notes, callback_at: input.callbackAt }, input.now);
  if (!fields.ok) {
    const reason = fields.code === 'note_required' || fields.code === 'datetime_required' ? fields.code : 'invalid_callback_at';
    return { ok: false, refusal: { code: 'disposition_invalid', reason } };
  }
  const submitted = submittedCallFields(input.callFields, input.submittedFields);
  const values = validateCallFieldValues(
    input.callFields,
    submitted === undefined ? storedValuesInForce(input.callFields, input.storedFields) : submitted,
    { requireFilled: true },
  );
  if (!values.ok) return { ok: false, refusal: { code: 'fields_invalid', details: values.details } };
  return {
    ok: true,
    prepared: {
      entry: resolved.entry,
      notes: fields.notes,
      callbackAt: fields.callbackAt,
      fields: submitted === undefined ? undefined : values.values,
    },
  };
}

/**
 * The roster decision an outcome implies (§5), as the station's disposition route
 * computes it: `resolveDispositionDecision` with
 * `attemptsUsed = attempt_count + (placed ? 1 : 0)` — `settleFromManual` makes the
 * bump, so the decision is computed on the count it will leave — and a callback
 * deferred into the contact's calling window (`scheduleCallbackInWindow`), only
 * when the decision scheduled one.
 */
export function manualDispositionDecision(input: {
  entry: AgencyDisposition;
  now: Date;
  callbackAt: Date | null;
  placed: boolean;
  contact: Pick<AgencyContactRecord, 'attempt_count' | 'timezone'> | null;
  tag: Pick<AgencyCampaignRecord, 'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'> | null;
}): { decision: DispositionDecision; nextAttemptAt: Date | null } {
  const attemptsUsed = (input.contact?.attempt_count ?? 0) + (input.placed ? 1 : 0);
  const decision = resolveDispositionDecision(input.entry, {
    now: input.now, attemptsUsed, callbackAt: input.callbackAt,
  });
  let nextAttemptAt = decision.nextAttemptAt;
  if (nextAttemptAt && input.callbackAt && input.tag) {
    const window = resolveCallingWindow(input.tag, { timezone: input.contact?.timezone ?? null });
    nextAttemptAt = scheduleCallbackInWindow(window, input.callbackAt);
  }
  return { decision, nextAttemptAt };
}
