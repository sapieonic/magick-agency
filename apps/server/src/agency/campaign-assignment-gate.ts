import type { FastifyReply } from 'fastify';
import { AGENCY_CONTACT_ASSIGNMENT_DEFAULTS } from '@magick-agency/contracts/agency';
import { getFeatureFlagService, FLAGS } from '../feature-flags/index.js';

/*
 * The campaign-write gate for contact assignment (decision D9): the
 * `agency_contact_assignment_enabled` flag gates the SURFACE, so a campaign create,
 * PATCH or retry that asks for any of it, while the flag is off for the account, is
 * refused 403 `feature_disabled` and nothing is forwarded. It never gates the runtime:
 * pacing reads the stored `assignment_mode` whatever the flag says.
 *
 * "Asks for any of it" is a setting sent with a value OTHER than its default
 * (`AGENCY_CONTACT_ASSIGNMENT_DEFAULTS`), or a disposition catalog entry carrying an
 * `override`. A default sent explicitly asks for nothing: the console's settings form
 * re-sends every field on every save, and a tenant without the feature must still be
 * able to save a campaign (and to put a setting BACK to its default, the way out after
 * the flag is turned off). Called after the shape validators, so every value here is
 * already well-formed.
 */

/** The 0009 campaign settings the flag gates. */
const ASSIGNMENT_SETTING_KEYS = Object.keys(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS) as Array<
  keyof typeof AGENCY_CONTACT_ASSIGNMENT_DEFAULTS
>;

/**
 * The fields of `config` that need the flag: each assignment setting whose value is not
 * its default, and each catalog entry's `override` (as `disposition_catalog[i].override`).
 * Empty when the body asks for nothing the flag gates. Pure.
 */
export function assignmentFieldsRequested(config: unknown): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [];
  const record = config as Record<string, unknown>;
  const fields: string[] = ASSIGNMENT_SETTING_KEYS.filter(
    (key) => Object.hasOwn(record, key) && record[key] !== undefined
      && record[key] !== AGENCY_CONTACT_ASSIGNMENT_DEFAULTS[key],
  );
  const catalog = record['disposition_catalog'];
  if (Array.isArray(catalog)) {
    catalog.forEach((entry, i) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)
        && (entry as Record<string, unknown>)['override'] !== undefined) {
        fields.push(`disposition_catalog[${i}].override`);
      }
    });
  }
  return fields;
}

/**
 * Returns true to proceed. When `config` asks for something the flag gates and the
 * flag is off for `target`, the 403 has been sent and the caller must `return`. The
 * flag is read only when something is asked for, so an ordinary save costs nothing; a
 * flag read that throws propagates (a 500: fail closed, nothing forwarded).
 *
 * `config` is the exact object the route forwards (for a retry, its
 * `config_overrides`: what the child inherits unchanged is the parent's, already
 * stored, and is not this request's to re-litigate).
 */
export async function assertAssignmentSettingsAllowed(
  reply: FastifyReply,
  config: unknown,
  target: { tenantId: string; accountId?: string | null },
): Promise<boolean> {
  const fields = assignmentFieldsRequested(config);
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
