import { createChildLogger } from '@magick-agency/observability';
import { dncService } from '../dnc/dnc.service.js';
import { agencyRosterPresenceRepository } from '../db/repositories/agency.repository.js';
import {
  combineKeyParts,
  type AgencyDncScope,
  type AgencyIngestCandidate,
  type AgencyIngestKeyInfo,
  type AgencyIngestScreenResult,
} from './agency-csv-ingest.js';

const log = createChildLogger({ component: 'agency-ingest-screen' });

/** Contacts read per page when the roster's duplicate keys are loaded (column keys only). */
export const ROSTER_KEY_PAGE_SIZE = 5_000;

export interface IngestScreenScope {
  tenantId: string;
  accountId: string | null;
  /** The campaign the rows would join; null for a check that names none (no roster to compare). */
  campaignId: string | null;
  /**
   * The job itself: only contacts written before its `created_at` count as "already
   * in this campaign" (see `roster-presence.repository.ts`).
   */
  jobId: string;
}

const digitsOf = (phone: string): string => phone.replace(/[^0-9]/g, '');

/**
 * The ingest's per-batch screen (`AgencyIngestOptions.screen`): the Do Not Call list
 * and the campaign's roster, asked for one batch before any of its rows claims a
 * duplicate key. The check (`dry_run`) and the import build the same screen, so the
 * check reports what the import will do against the roster as it stood (IM1).
 *
 * **Do Not Call is fail-closed, unchanged:** `dncService.filterSuppressed` decides,
 * and its `DncUnavailableError` propagates and fails the job. The scope lookup
 * after it only labels the hits for the reason text; if it fails the rows are
 * still rejected, labelled `unknown`.
 *
 * **"Already in this campaign" (IM3)** is the operator's duplicate key read off the
 * roster: the number (phone key, served by the digits index), the key columns
 * (loaded once per job, paged, then answered from memory: the columns are the
 * operator's and no index can serve them), and for a row with no key (no duplicate
 * check, or a blank key part) an exact copy by `row_fingerprint`, which is the
 * insert's own refusal asked in advance.
 */
export function createIngestScreen(
  scope: IngestScreenScope,
): (candidates: readonly AgencyIngestCandidate[], key: AgencyIngestKeyInfo) => Promise<AgencyIngestScreenResult> {
  /**
   * The roster's column keys, loaded on the first batch that needs them and held for
   * the job: O(contacts already in the campaign), one short string each. A phone key
   * and an exact copy are asked per batch instead and hold nothing. Checks are not
   * limited per campaign (IM7 limits imports), so concurrent checks each hold a copy.
   */
  let rosterKeys: Promise<Set<string>> | null = null;

  const loadRosterKeys = async (key: AgencyIngestKeyInfo, campaignId: string): Promise<Set<string>> => {
    const keys = new Set<string>();
    let after: { created_at: string; id: string } | null = null;
    for (;;) {
      const page = await agencyRosterPresenceRepository.keyPartsPage(
        campaignId, scope.jobId, key.columns, key.phone_parts, after, ROSTER_KEY_PAGE_SIZE,
      );
      for (const row of page) {
        const combined = combineKeyParts(row.parts);
        if (combined !== null) keys.add(combined);
      }
      if (page.length < ROSTER_KEY_PAGE_SIZE) break;
      const last = page[page.length - 1]!;
      after = { created_at: last.created_at, id: last.id };
    }
    return keys;
  };

  return async (candidates, key) => {
    const phones = [...new Set(candidates.map((c) => c.phone_e164))];
    const lookupScope = {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      // Campaign-scoped rows must be caught here as well as at dial time, so the
      // campaign is part of the lookup.
      campaignId: scope.campaignId,
    };
    const suppressed = await dncService.filterSuppressed(lookupScope, phones);
    const dnc = new Map<string, AgencyDncScope>();
    if (suppressed.size > 0) {
      let scopes = new Map<string, 'tenant' | 'account' | 'campaign'>();
      try {
        scopes = await dncService.suppressionScopes(lookupScope, [...suppressed]);
      } catch (err) {
        log.warn({ err, tenantId: scope.tenantId }, 'Could not read Do Not Call scopes; the rows are still rejected');
      }
      for (const phone of suppressed) dnc.set(phone, scopes.get(phone) ?? 'unknown');
    }

    const existing = new Set<number>();
    const campaignId = scope.campaignId;
    if (campaignId && candidates.length > 0) {
      const unkeyed: number[] = [];
      if (key.mode === 'phone') {
        const present = await agencyRosterPresenceRepository.phonesPresent(
          campaignId, scope.jobId, [...new Set(candidates.map((c) => digitsOf(c.phone_e164)))],
        );
        candidates.forEach((c, i) => { if (present.has(digitsOf(c.phone_e164))) existing.add(i); });
      } else if (key.mode === 'column') {
        rosterKeys ??= loadRosterKeys(key, campaignId);
        const keys = await rosterKeys;
        candidates.forEach((c, i) => {
          if (c.key === null) unkeyed.push(i);
          else if (keys.has(c.key)) existing.add(i);
        });
      } else {
        candidates.forEach((_, i) => unkeyed.push(i));
      }
      if (unkeyed.length > 0) {
        const exact = await agencyRosterPresenceRepository.exactRowsPresent(
          campaignId, scope.jobId, unkeyed.map((i) => candidates[i]!),
        );
        for (const position of exact) existing.add(unkeyed[position]!);
      }
    }
    return { dnc, existing };
  };
}
