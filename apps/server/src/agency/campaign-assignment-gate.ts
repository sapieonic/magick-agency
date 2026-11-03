import type { FastifyReply } from 'fastify';
import { AGENCY_CONTACT_ASSIGNMENT_DEFAULTS } from '@magick-agency/contracts/agency';
import { getFeatureFlagService, FLAGS } from '../feature-flags/index.js';

/*
 * The campaign-write gate for contact assignment (decision CA9): the
 * `agency_contact_assignment_enabled` flag gates the SURFACE, so a campaign create,
 * PATCH or retry that asks for any of it, while the flag is off for the account, is
 * refused 403 `feature_disabled` and nothing is forwarded. It never gates the runtime:
 * pacing reads the stored `assignment_mode` whatever the flag says.
 *
 * "Asks for any of it" is a setting sent with a value OTHER than its default
 * (`AGENCY_CONTACT_ASSIGNMENT_DEFAULTS`) or than the value already stored, or a disposition
 * catalog entry whose `override` differs from the stored entry of the same code. What the
 * campaign already holds asks for nothing: the console's settings form re-sends every field
 * (and the whole catalog) on every save, and a campaign set up while the flag was on must
 * still save its other fields after it is turned off. A default sent explicitly asks for
 * nothing either: putting a setting BACK to its default, or dropping an override, is the way
 * out after the flag is turned off. Called after the shape validators, so every value here
 * is already well-formed.
 */

/** The 0009 campaign settings the flag gates. */
const ASSIGNMENT_SETTING_KEYS = Object.keys(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS) as Array<
  keyof typeof AGENCY_CONTACT_ASSIGNMENT_DEFAULTS
>;

/** A plain object, or null. */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** JSON with sorted keys: equal overrides compare equal whatever order their keys came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = record(value);
  if (obj) return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The fields of `config` that need the flag: each assignment setting whose value is neither
 * its default nor the stored value, and each catalog entry's `override` (as
 * `disposition_catalog[i].override`) that differs from the stored entry of the same code.
 * `stored` is the campaign as the internal handler answers it (or, for a retry, the parent);
 * absent, only the defaults ask for nothing. Empty when the body asks for nothing the flag
 * gates. Pure.
 */
export function assignmentFieldsRequested(config: unknown, stored?: unknown): string[] {
  const body = record(config);
  if (!body) return [];
  const before = record(stored);
  const fields: string[] = ASSIGNMENT_SETTING_KEYS.filter((key) => {
    if (!Object.hasOwn(body, key) || body[key] === undefined) return false;
    if (body[key] === AGENCY_CONTACT_ASSIGNMENT_DEFAULTS[key]) return false;
    return !(before && Object.hasOwn(before, key) && before[key] === body[key]);
  });
  const storedOverrides = new Map<unknown, string>();
  if (before && Array.isArray(before['disposition_catalog'])) {
    for (const entry of before['disposition_catalog']) {
      const e = record(entry);
      if (e && e['override'] !== undefined && e['override'] !== null) storedOverrides.set(e['code'], canonical(e['override']));
    }
  }
  const catalog = body['disposition_catalog'];
  if (Array.isArray(catalog)) {
    catalog.forEach((entry, i) => {
      const e = record(entry);
      if (!e || e['override'] === undefined || e['override'] === null) return;
      if (storedOverrides.get(e['code']) === canonical(e['override'])) return;
      fields.push(`disposition_catalog[${i}].override`);
    });
  }
  return fields;
}

/**
 * Returns true to proceed. When `config` asks for something the flag gates and the
 * flag is off for `target`, the 403 has been sent and the caller must `return`. The
 * stored campaign (`loadStored`, null when it cannot be read: then only the defaults
 * pass) and the flag are read only when something differs from the defaults, so an
 * ordinary save costs nothing; a read that throws propagates (a 500: fail closed,
 * nothing forwarded).
 *
 * `config` is the exact object the route forwards (for a retry, its
 * `config_overrides`: what the child inherits unchanged is the parent's, already
 * stored, and is not this request's to re-litigate).
 */
export async function assertAssignmentSettingsAllowed(
  reply: FastifyReply,
  config: unknown,
  target: { tenantId: string; accountId?: string | null },
  loadStored?: () => Promise<unknown>,
): Promise<boolean> {
  if (assignmentFieldsRequested(config).length === 0) return true;
  // Something differs from the defaults: judge it against what the campaign already holds.
  const fields = loadStored ? assignmentFieldsRequested(config, await loadStored()) : assignmentFieldsRequested(config);
  if (fields.length === 0) return true;
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_contact_assignment_enabled, {
    tenantId: target.tenantId,
    ...(target.accountId ? { accountId: target.accountId } : {}),
  });
  if (enabled) return true;
  reply.code(403).send({
    error: 'Feature Not Enabled',
    code: 'feature_disabled',
    message: 'Contact assignment is not enabled for this account. Leave these settings at their defaults.',
    details: Object.fromEntries(fields.map((field) => [field, 'needs contact assignment, which is not enabled'])),
  });
  return false;
}
