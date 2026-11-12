import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  AGENCY_STALL_LABELS,
  sortStallCodes,
  splitFact,
  stallCopy,
} from '../../utils/agencyHealthStrip';
import { formatDate } from '@magick-agency/web-ui/format';
import { agentsOnShift } from '../../utils/agencyAgentFloor';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { hasPermission } from '../../utils/permissions';
import {
  trackAgencyCampaignStallExpanded,
  trackAgencyCampaignStallSurfaced,
} from '../../analytics/events';
import type { AgencyCampaignStats } from '../../types/agency-campaign';
import type { Role } from '../../types/auth';
import styles from './CampaignHealthStrip.module.css';

/**
 * The supervisor health strip: the one diagnosis of what is stopping a campaign dialling.
 *
 * ── One diagnosis, or none ──────────────────────────────────────────────────
 * `stall: null` renders **nothing**. Not a green "all good" banner: a banner
 * that is present when everything is fine trains a supervisor to skim past the
 * one place a real diagnosis will appear, and the strip's whole value is that
 * its presence means something.
 *
 * ── The diagnosis reads across, not down ────────────────────────────────────
 * Headline, then the evidence as a wrapped run of short facts with the numbers
 * emphasised, then the actions pinned right. It was a tall stack of paragraphs
 * down the left of a full-width slab, which put the one thing a supervisor can
 * DO about the blocker nowhere at all — so the sentence that used to stand in
 * for an action ("Last call placed at …") is now what it always was, evidence.
 *
 * ── No read-outs ────────────────────────────────────────────────────────────
 * It used to carry the account's concurrency and abandonment read-outs too, in a
 * second instance on the Overview panel. The Insights tab replaced that panel
 * (IN1) and serves both figures from its own reads, so the strip is the
 * diagnosis alone.
 */

export interface CampaignHealthStripProps {
  /** Null while the first load is in flight, or when the stats read failed. */
  stats: AgencyCampaignStats | null;
  /** Attributes the stall-surfaced/-expanded analytics events to a campaign. */
  campaignId: string;
  /**
   * `string`, matching `AgencyCampaign.status` itself — narrowed to the
   * `AgencyCampaignStatus` enum via `isKnownCampaignStatus` before
   * `trackAgencyCampaignStallSurfaced` fires, and skipped for anything else.
   */
  campaignStatus: string;
  /**
   * The viewer's role in the active account, which gates the two action links.
   *
   * **Optional, and `undefined` renders NEITHER link.** A caller that does not
   * know the role cannot have established that the viewer may follow them, and
   * the API enforces `agency.supervise` on the floor and `audit.read` on the
   * activity trail — a link that renders and then 403s on arrival is worse than
   * no link, so an unknown role is treated exactly like an insufficient one.
   * (`hasPermission` already answers `false` for `undefined`; this is why.)
   */
  role?: Role;
}

export function CampaignHealthStrip({
  stats,
  campaignId,
  campaignStatus,
  role,
}: CampaignHealthStripProps) {
  const [showOthers, setShowOthers] = useState(false);
  const stall = stats?.stall ?? null;
  // Sorted here, never trusted from the array. The API does send them in priority
  // order; relying on that would let a producer-side reorder silently change
  // what a supervisor reads with nothing on this side going red.
  const others = sortStallCodes(stats?.other_stalls ?? []);

  // "N agents on shift" by the floor's own count, so it agrees with the floor and the tab badge.
  const copy = stall ? stallCopy(stall, formatDate, { agentsOnShift: agentsOnShift(stats?.agents) }) : null;

  // The API's own floors on the two destinations, checked before the link exists
  // rather than after the supervisor has followed it. See the `role` prop.
  const canOpenFloor = hasPermission(role, 'agency.supervise');
  const canSeeActivity = hasPermission(role, 'audit.read');

  /*
    First-surfaced-per-mount analytics, deduped per `campaignId:code` so the
    10s stats poll (`AgencyCampaignDetailPage`) doesn't refire on every tick.
  */
  const surfacedStallsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!stall || !isKnownCampaignStatus(campaignStatus)) return;
    const codes = [stall.code, ...others];
    const concurrencySaturated = codes.includes('concurrency_saturated');
    const abandonmentOverCeiling = codes.includes('auto_paused_abandonment');
    for (const code of codes) {
      const key = `${campaignId}:${code}`;
      if (surfacedStallsRef.current.has(key)) continue;
      surfacedStallsRef.current.add(key);
      trackAgencyCampaignStallSurfaced({
        campaign_id: campaignId,
        code,
        other_stall_count: codes.length - 1,
        campaign_status: campaignStatus,
        concurrency_saturated: concurrencySaturated,
        abandonment_over_ceiling: abandonmentOverCeiling,
      });
    }
  }, [campaignId, campaignStatus, stall, others]);

  if (!copy) return null;

  return (
    <div className={styles.wrap}>
      <section
        className={styles.diagnosis}
        data-testid="health-strip-diagnosis"
        data-stall-code={stall!.code}
        aria-live="polite"
      >
        <span className={styles.diagnosisIcon} aria-hidden="true">
          <AlertTriangle size={18} />
        </span>
        <div className={styles.diagnosisBody}>
          <p className={styles.headline}>{copy.headline}</p>
          <p className={styles.evidence}>
            {copy.facts.map((fact, index) => {
              const { before, value, after } = splitFact(fact);
              return (
                // Keyed by position: the facts are a fixed run derived from
                // one payload, and the text itself changes on every poll.
                <span key={index}>
                  {/*
                    A REAL separator, not the CSS `gap` that draws it.
                    Adjacent spans with only a gap between them concatenate on
                    copy/paste and for a screen reader: "9 agents on shift7 on
                    a call". The joined `evidence` string in the same module
                    already uses ` · `, so this is the same character the copy
                    was written against. Deliberately NOT `aria-hidden`: hiding
                    it would leave the screen reader with exactly the run-on
                    this exists to prevent.
                  */}
                  {index > 0 && ' · '}
                  {before}
                  {value && <strong>{value}</strong>}
                  {after}
                </span>
              );
            })}
          </p>
          {copy.advice && <p className={styles.advice}>{copy.advice}</p>}

          {others.length > 0 && (
            <div className={styles.others}>
              <button
                type="button"
                className={styles.othersToggle}
                onClick={() => {
                  setShowOthers((open) => {
                    const next = !open;
                    // Only the reveal is "expanded" — collapsing isn't a
                    // second look at the other blockers.
                    if (next) {
                      trackAgencyCampaignStallExpanded({
                        campaign_id: campaignId,
                        code: stall!.code,
                        other_stall_count: others.length,
                      });
                    }
                    return next;
                  });
                }}
                aria-expanded={showOthers}
              >
                {showOthers ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {others.length === 1 ? '1 additional blocker' : `${others.length} additional blockers`}
              </button>
              {showOthers && (
                <ul className={styles.othersList} data-testid="health-strip-others">
                  {others.map((code) => (
                    <li key={code}>{AGENCY_STALL_LABELS[code]}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {(canOpenFloor || canSeeActivity) && (
          <div className={styles.diagnosisActions}>
            {canOpenFloor && (
              <Link className={styles.diagnosisAction} to={`/agency/campaigns/${campaignId}/agents`}>
                Open the floor
              </Link>
            )}
            {canSeeActivity && (
              <Link className={styles.diagnosisAction} to={`/agency/campaigns/${campaignId}/activity`}>
                See the activity trail
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default CampaignHealthStrip;
