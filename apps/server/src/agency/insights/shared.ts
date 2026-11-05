/**
 * What the insights sections share: the catalog's codes, the user references and their names,
 * and the reconciliation entry. Part of `src/agency/insights/` (docs/insights.md "API").
 */
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { AgencyInsightsActor, AgencyInsightsReconciliation } from '@magick-agency/contracts/api/agency/insights';
import { createChildLogger } from '@magick-agency/observability';
import { resolveAgentNames } from '../agency-agent-identity.js';
import { UUID_RE } from '../../utils/uuid.js';

const log = createChildLogger({ component: 'agency-insights' });

/** The catalog's `is_success` codes (the stats' `successDispositionSql` reads the same flag). */
export function successCodes(catalog: readonly AgencyDisposition[] | null | undefined): string[] {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((d) => !!d && typeof d === 'object' && typeof d.code === 'string' && d.is_success === true)
    .map((d) => d.code);
}

/** Whether a catalog entry grants an outcome override (the settings block's `override_outcomes`). */
export function grantsOverride(d: AgencyDisposition | null | undefined): d is AgencyDisposition {
  return !!d && typeof d === 'object' && typeof d.code === 'string' && !!d.override && typeof d.override === 'object';
}

/** The catalog's override-granting codes (the rollup's overrides read filters by them). */
export function overrideCodes(catalog: readonly AgencyDisposition[] | null | undefined): string[] {
  return Array.isArray(catalog) ? catalog.filter(grantsOverride).map((d) => d.code) : [];
}

/**
 * A user id out of a stored actor reference: a bare UUID, or `user:<uuid>`. Anything else (a
 * system label such as `system:api`, an email, NULL) is not a user and answers null.
 * `agency_campaigns.created_by` held the originator label and is moving to the creator's user
 * id; both spellings are read.
 */
export function userIdOf(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const raw = ref.startsWith('user:') ? ref.slice('user:'.length) : ref;
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Display names for `ids` in the tenant (display name, else email), one query. A lookup that
 * fails degrades to no names, never to a failed read: a name is an improvement on the id.
 */
export async function namesIn(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (unique.length === 0) return new Map();
  try {
    return await resolveAgentNames(unique, tenantId);
  } catch (err) {
    log.warn({ tenantId, users: unique.length, err: err instanceof Error ? err.message : String(err) },
      'insights: name resolution failed; emitting name: null');
    return new Map();
  }
}

/** `{ user_id, name }`, or null for no user (the system). */
export function actorOf(userId: string | null, names: ReadonlyMap<string, string | null>): AgencyInsightsActor | null {
  return userId === null ? null : { user_id: userId, name: names.get(userId) ?? null };
}

/** One reconciliation entry. */
export function reconcile(check: string, expected: number, actual: number): AgencyInsightsReconciliation {
  return { check, expected, actual, ok: expected === actual };
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * A range read found no campaign for the tenant: it left between the route's ownership probe and
 * the read (deleted mid-request). The route has already proved ownership, so this is a 500, not a
 * 404 that would race the probe.
 */
export class InsightsCampaignGone extends Error {
  constructor() {
    super('insights: campaign not found for its tenant after the ownership probe');
  }
}
