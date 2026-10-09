import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  AGENCY_STALL_LABELS,
  abandonmentReadout,
  concurrencyReadout,
  sortStallCodes,
  splitFact,
  stallCopy,
} from '../../utils/agencyHealthStrip';
import { formatDate } from '../../utils/format';
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
 * The supervisor health strip (§C.2) and the two read-outs beside it (§C.3,
 * CR-2) — "the actual feature" of the supervisor dashboard.
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
 * ── The read-outs render regardless ─────────────────────────────────────────
 * Concurrency and abandonment are not diagnoses — they are the two numbers a
 * supervisor checks *before* anything is wrong, and the abandonment one is the
 * threshold that will eventually pause the campaign. They stay on screen whether
 * or not the campaign is stalled.
 */

export interface CampaignHealthStripProps {
  /** Null while the first load is in flight, or when the stats read failed. */
  stats: AgencyCampaignStats | null;
  /** Lets the dashboard place the diagnosis and live read-outs at their useful visual levels. */
  mode?: 'all' | 'diagnosis' | 'readouts';
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
   * master enforces `agency.supervise` on the floor and `audit.read` on the
   * activity trail — a link that renders and then 403s on arrival is worse than
   * no link, so an unknown role is treated exactly like an insufficient one.
   * (`hasPermission` already answers `false` for `undefined`; this is why.)
   */
  role?: Role;
  /**
   * True once the campaign has finished — it changes the TENSE of the
   * abandonment read-out, which is a rolling ACCOUNT figure and therefore
   * describes this afternoon rather than the campaign being reviewed.
   *
   * Defaults to `false`, which is the live wording. A caller that does not know
   * the status is describing a campaign it believes is running, and that is the
   * safe assumption: the live copy is merely unhelpful on a dead campaign, while
   * the terminal copy on a live one would tell a supervisor their running
   * campaign had stopped.
   */
  finished?: boolean;
}

export function CampaignHealthStrip({
  stats,
  mode = 'all',
  campaignId,
  campaignStatus,
  role,
  finished = false,
}: CampaignHealthStripProps) {
  const [showOthers, setShowOthers] = useState(false);
  const stall = stats?.stall ?? null;
  // Sorted here, never trusted from the array. Core does send them in priority
  // order; relying on that would let a producer-side reorder silently change
  // what a supervisor reads with nothing on this side going red.
  const others = sortStallCodes(stats?.other_stalls ?? []);

  const concurrency = concurrencyReadout(stats?.concurrency_limit, stats?.concurrency_in_use);
  const abandonment = abandonmentReadout(
    stats?.abandonment_rate_24h_pct,
    stats?.abandonment_ceiling_pct,
    { abandoned: stats?.abandoned_24h, answered: stats?.answered_24h },
    finished,
  );

  const copy = stall ? stallCopy(stall, formatDate) : null;
  const showDiagnosis = mode !== 'readouts';
  const showReadouts = mode !== 'diagnosis';

  // Master's own floors on the two destinations, checked before the link exists
  // rather than after the supervisor has followed it. See the `role` prop.
  const canOpenFloor = hasPermission(role, 'agency.supervise');
  const canSeeActivity = hasPermission(role, 'audit.read');

  /*
    First-surfaced-per-mount analytics, deduped per `campaignId:code` so the
    10s stats poll (`AgencyCampaignDetailPage`) doesn't refire on every tick.
    Gated on `showDiagnosis` so the `mode="readouts"` instance mounted
    alongside this one on the Overview panel — which never renders the
    diagnosis section at all — never double-counts the same stall.
  */
  const surfacedStallsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!showDiagnosis || !stall || !isKnownCampaignStatus(campaignStatus)) return;
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
  }, [campaignId, campaignStatus, showDiagnosis, stall, others]);

  if (mode === 'diagnosis' && !copy) return null;

  return (
    <div className={styles.wrap} data-mode={mode}>
      {showDiagnosis && copy && (
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
      )}

      {showReadouts && <div className={styles.readouts}>
        {/*
          CR-2 / D10: concurrency is a READ-OUT. No input, no stepper, no "change
          this" link — the supervisor sees it and cannot set it, and rendering
          any affordance would be a claim the platform cannot honour.
        */}
        <div
          className={styles.readout}
          data-testid="concurrency-readout"
          data-unknown={concurrency.unknown ? 'true' : 'false'}
          data-saturated={concurrency.saturated ? 'true' : 'false'}
        >
          <div className={styles.readoutHead}>
            <span className={styles.readoutLabel}>Account lines in use</span>
            <span
              className={concurrency.saturated ? styles.readoutValueAlert : styles.readoutValue}
            >
              {concurrency.value}
            </span>
          </div>
          {/*
            `aria-hidden`, on both meters: they are a picture of the value and
            the detail sentence beside them, which are already read out. A
            second announcement of the same number is noise, not access.

            `fill === null` draws NO bar — never a zero-width one. An empty
            track reads as "we have not drawn this"; a 0% fill reads as "idle",
            which is a claim about the account we cannot make from a count we
            failed to read.
          */}
          <div className={styles.meter} aria-hidden="true">
            {concurrency.fill !== null && (
              <div
                className={concurrency.saturated ? styles.meterFillAlert : styles.meterFill}
                style={{ width: `${concurrency.fill * 100}%` }}
              />
            )}
          </div>
          <span className={styles.readoutDetail}>{concurrency.detail}</span>
        </div>

        <div
          className={styles.readout}
          data-testid="abandonment-readout"
          data-over={abandonment.over ? 'true' : 'false'}
        >
          <div className={styles.readoutHead}>
            <span className={styles.readoutLabel}>Account abandonment · 24h</span>
            <span
              className={
                abandonment.over || abandonment.nearCeiling
                  ? styles.readoutValueAlert
                  : styles.readoutValue
              }
            >
              {abandonment.value}
            </span>
          </div>
          {/*
            The track's full width IS this campaign's own ceiling, so the tick
            sits at the end of it. Drawn only when the ceiling loaded: a tick
            with no number behind it would be a threshold we invented.
          */}
          <div className={styles.meterTrack} aria-hidden="true">
            {abandonment.fill !== null && (
              <div
                className={styles.meterFill}
                data-band={abandonment.band}
                style={{ width: `${abandonment.fill * 100}%` }}
              />
            )}
            {abandonment.ceilingLabel && (
              <span className={styles.meterCeiling} title={abandonment.ceilingLabel} />
            )}
          </div>
          <span className={styles.readoutDetail}>{abandonment.detail}</span>
        </div>
      </div>}
    </div>
  );
}

export default CampaignHealthStrip;
