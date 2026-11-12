import { useEffect, useSyncExternalStore } from 'react';
import { getAgencyCampaignStats } from '../api/agencyCampaigns';
import { getInsightsAllocation } from '../api/agencyInsights';
import { agentsOnShift } from '../utils/agencyAgentFloor';
import { useTenant } from '../contexts/TenantContext';

/** A badge count this recent is shown as it is, not read again (list → call → back → next call). */
export const TAB_BADGE_FRESH_MS = 30_000;

/**
 * The campaign bar's two badge counts, shared by every campaign screen of the tab: Agents on shift
 * (from the campaign's stats) and Callbacks overdue (from the insights allocation). One store
 * keyed by tenant, account and campaign, so a standalone screen reuses an answer under
 * {@link TAB_BADGE_FRESH_MS} old (the detail page's poll publishes into it with
 * {@link publishCampaignTabBadge}) and two screens reading at once share one request.
 */
export type CampaignTabBadgeKind = 'onShift' | 'overdue';

interface Entry {
  value: number | null;
  at: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** Bumped by {@link resetCampaignTabBadges}, so a read begun before a sign-out stores nothing after it. */
let generation = 0;

function badgeKey(kind: CampaignTabBadgeKind, tenantId: string, accountId: string, campaignId: string): string {
  return `${kind}|${tenantId}/${accountId}/${campaignId}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(key: string, value: number | null): void {
  entries.set(key, { value, at: Date.now() });
  for (const listener of listeners) listener();
}

/** A host that already holds a count (the detail page's poll) hands it to every other screen. */
export function publishCampaignTabBadge(
  kind: CampaignTabBadgeKind,
  tenantId: string,
  accountId: string,
  campaignId: string,
  value: number,
): void {
  store(badgeKey(kind, tenantId, accountId, campaignId), value);
}

async function fetchBadge(kind: CampaignTabBadgeKind, tenantId: string, accountId: string, campaignId: string): Promise<number | null> {
  if (kind === 'onShift') return agentsOnShift((await getAgencyCampaignStats(campaignId, tenantId, accountId)).agents);
  return (await getInsightsAllocation(campaignId, tenantId, accountId)).totals.callbacks_overdue ?? null;
}

/** Read unless a fresh answer is held or a read is already on its way. */
function readBadge(kind: CampaignTabBadgeKind, tenantId: string, accountId: string, campaignId: string): void {
  const key = badgeKey(kind, tenantId, accountId, campaignId);
  const held = entries.get(key);
  if (inFlight.has(key) || (held && Date.now() - held.at < TAB_BADGE_FRESH_MS)) return;
  const asked = generation;
  const promise = fetchBadge(kind, tenantId, accountId, campaignId)
    .then((value) => {
      if (asked === generation) store(key, value);
    })
    // A failed read keeps what was held; the next screen tries again.
    .catch(() => undefined)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
}

/**
 * Forget every held count, and any read still on its way. Sign-out is in place, not a page load
 * (`AuthContext`), so the next person to sign in to the same account in this tab would otherwise
 * be shown the last one's counts.
 */
export function resetCampaignTabBadges(): void {
  generation += 1;
  entries.clear();
  inFlight.clear();
  for (const listener of listeners) listener();
}

/** The name the tests know it by. */
export const resetCampaignTabBadgesForTests = resetCampaignTabBadges;

/**
 * One badge count for the campaign, read once on mount when nothing fresh is held (not polled: a
 * standalone screen is a short visit). Null while `enabled` is false and until an answer.
 */
export function useCampaignTabBadge(kind: CampaignTabBadgeKind, campaignId: string, enabled: boolean): number | null {
  const { tenantId, accountId } = useTenant();
  const key = tenantId && accountId ? badgeKey(kind, tenantId, accountId, campaignId) : null;
  const entry = useSyncExternalStore(subscribe, () => (key ? entries.get(key) : undefined));
  const active = enabled && key !== null;

  useEffect(() => {
    if (active && tenantId && accountId) readBadge(kind, tenantId, accountId, campaignId);
  }, [active, kind, tenantId, accountId, campaignId]);

  return active ? entry?.value ?? null : null;
}
