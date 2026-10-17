import { useMemo } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { CampaignHealthStrip } from '../../../components/agency/CampaignHealthStrip';
import { CampaignSeriesSection } from '../../../components/agency/CampaignSeriesSection';
import {
  contactFunnel,
  floorSummary,
  funnelBarWithheldNote,
  howItEndedLines,
  howItRanLines,
  listWorkedRing,
  onCallNote,
  pulseFigures,
  retriesNote,
  RING_RADIUS,
  type OverviewFigure,
} from '../../../utils/agencyCampaignOverview';
import type { CampaignEnding } from '../../../utils/agencyCampaignControls';
import type { Role } from '../../../types/auth';
import type { AgencyCampaign, AgencyCampaignStats } from '../../../types/agency-campaign';
import styles from '../AgencyCampaignDetailPage.module.css';

/**
 * One cell of the pulse strip.
 *
 * The strip is deliberately one card rather than six tiles: these six numbers
 * are read as a sentence — how far through the list, how many dials that took,
 * how many reached anyone, how many were real conversations, how many counted,
 * and how many are up right now — and six bordered boxes invite them to be read
 * as six unrelated facts.
 *
 * `data-known` rather than a second class: an absent number is styled down
 * because it is a statement about our knowledge, not about the campaign.
 */
function PulseCell({
  label,
  figure,
  tone,
  testId,
}: {
  label: string;
  figure: OverviewFigure;
  tone?: 'accent' | 'live';
  testId: string;
}) {
  const cell = tone === 'live' ? `${styles.pulseCell} ${styles.pulseLive}` : styles.pulseCell;
  const value = tone === 'accent' ? `${styles.pulseValue} ${styles.pulseAccent}` : styles.pulseValue;
  return (
    <div className={cell} data-testid={testId}>
      <span className={styles.kicker}>{label}</span>
      <span className={value} data-known={String(figure.known)}>{figure.value}</span>
      {figure.sub && <span className={styles.pulseSub}>{figure.sub}</span>}
    </div>
  );
}

interface CampaignOverviewPanelProps {
  campaign: AgencyCampaign;
  stats: AgencyCampaignStats | null;
  /** How the campaign ended, or `null` while it is not terminal. */
  ending: CampaignEnding | null;
  /** The page's one `now` for this render, shared with the header's timeline. */
  now: Date;
  role: Role | undefined;
  /** Bumped by the header's Refresh so the series chart re-reads. */
  seriesRefresh: number;
}

/**
 * The campaign's Overview panel: the pulse strip, the funnel, the live rail and
 * the activity chart. Out of `AgencyCampaignDetailPage`, which mounts it only
 * while the Overview tab is open.
 */
export function CampaignOverviewPanel({
  campaign,
  stats,
  ending,
  now,
  role,
  seriesRefresh,
}: CampaignOverviewPanelProps) {
  const terminal = ending !== null;
  /*
    Every figure on the Overview panel is derived in `agencyCampaignOverview`,
    which is pure and unit-tested. Nothing below divides, sums or formats — a
    derivation inlined into JSX is a claim about the campaign that no test can
    reach, and this payload is entirely optional-and-nullable fields where a
    missing number must never render as a zero.
  */
  // Memoised on the payload: the page re-renders on every poll, keystroke and
  // dialog, and none of these change unless the stats or the campaign do.
  const { ring, funnel, pulse, retries, floor } = useMemo(() => ({
    ring: listWorkedRing(stats),
    funnel: contactFunnel(stats),
    pulse: pulseFigures(stats),
    retries: retriesNote(stats),
    floor: floorSummary(stats),
  }), [stats]);
  // The ENDING, not `terminal` — the note names which of the two it is, and a
  // boolean here is what made it tell a Completed campaign it had stopped.
  const stuck = useMemo(() => onCallNote(funnel, ending), [funnel, ending]);
  const barWithheld = useMemo(() => funnelBarWithheldNote(funnel), [funnel]);
  const howItRan = useMemo(() => howItRanLines(campaign), [campaign]);

  /*
    Only ever on a terminal campaign, and only when there is something to say.
    `howItEndedLines` returns `[]` rather than a list of dashes, so the whole
    block — heading and divider included — is skipped instead of announcing an
    ending nobody can read.
  */
  const howItEnded = ending ? howItEndedLines(campaign, stats, ending, now) : [];

  return (
    <section className={styles.overview} aria-label="Campaign overview">
      {/*
        ── Zone A · the pulse strip ────────────────────────────────────────
        One row answering "how far, how well, how busy" before anything has to
        be scrolled to. It absorbs the three counters that used to sit under a
        "Dialing activity" rule at the bottom of the panel — attempts,
        connected and retries-queued — which is where a supervisor found them
        only after reading past the numbers they explain.
      */}
      <div className={`${styles.card} ${styles.pulse}`} aria-label="Campaign at a glance">
        <div className={styles.pulseRing} data-testid="total-contacts">
          <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
            <circle className={styles.ringTrack} cx="36" cy="36" r={RING_RADIUS} fill="none" strokeWidth="9" />
            {/*
              Rotated so the arc starts at twelve o'clock, and `round`-capped
              so a 1% ring is still a visible mark rather than a stray pixel.
              A zero-length dash draws nothing at all, which is the right
              picture for a list nothing has touched.
            */}
            <circle
              className={styles.ringArc}
              cx="36"
              cy="36"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={ring.dashArray}
              transform="rotate(-90 36 36)"
            />
            <text className={styles.ringLabel} x="36" y="40" textAnchor="middle">{ring.label}</text>
          </svg>
          <div>
            <span className={styles.kicker}>List worked</span>
            <p className={styles.pulseRingTotal}>{ring.caption}</p>
            {ring.known && (
              <p className={`${styles.hint} ${styles.pulseRingHint}`}>
                Completed, suppressed or exhausted.
              </p>
            )}
          </div>
        </div>

        <PulseCell label="Dials placed" figure={pulse.dials} testId="pulse-dials" />
        <PulseCell label="Reached someone" figure={pulse.reached} testId="pulse-reached" />
        <PulseCell label="Spoke to a person" figure={pulse.humans} testId="pulse-humans" />
        <PulseCell label="Counted as a win" figure={pulse.wins} tone="accent" testId="pulse-wins" />
        {/*
          `active-attempts` keeps its test id from the operational rail it
          moved out of: it is the same figure, read for the same reason, and
          the poll predicate's own coverage waits on it.
        */}
        {/*
          The one figure in the strip whose LABEL is a tense. On a stopped
          campaign "On the line now" over a green-tinted 0 is a live read-out
          on a dead campaign — the rail beside it already switches to "The
          account right now" and hides the on-shift block on terminal, and this
          cell was the last thing `terminal` did not reach.

          "Still on the line" reads correctly either way: 0 is the expected
          answer and says so, and a non-zero is the same contradiction the
          funnel's stuck note names one panel down.
        */}
        <PulseCell
          label={terminal ? 'Still on the line' : 'On the line now'}
          figure={pulse.live}
          tone={terminal ? undefined : 'live'}
          testId="active-attempts"
        />
      </div>

      <div className={styles.row2}>
        {/*
          ── Zone B · the contact funnel ───────────────────────────────────
          One proportional bar instead of five equal boxes. The five states
          are simultaneous, not sequential, and equal boxes made 550 completed
          look the same size as 3 in flight — the one comparison the panel
          exists to make.
        */}
        <section className={styles.card} aria-labelledby="campaign-contacts-heading">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle} id="campaign-contacts-heading">
                {terminal ? 'Where the contacts finished' : 'Where the contacts stand'}
              </h2>
              {/*
                Neither sentence states a count.

                "…exactly one of these five states" was false the moment a
                contact was on a call — the roster has six states and the key
                now lists the sixth when it has something to say — and a
                sentence that counts the rows beneath it is a sentence that
                goes stale every time the key changes.

                "Nothing moves again" overclaimed in the other direction. A
                finished campaign places no NEW calls, which is not the same as
                nothing moving: the retries note directly below this can
                report a queued retry scheduled days out, and the stuck note
                beside it can report a contact still marked as on a call. Two
                notes contradicting the sentence they sit under is worse than
                a sentence that claims less.

                "Finished", not "stopped": `terminal` is true for `completed`
                as well, and this caption sits under a badge that says which.
                Naming one ending in a line that covers both is the conflation
                `howItEndedLines` exists to avoid.
              */}
              <p className={styles.cardDesc}>
                {terminal
                  ? 'Final positions. A finished campaign places no new calls.'
                  : 'Every contact is in exactly one of these states.'}
              </p>
            </div>
            <span className={styles.cardTag}>
              {terminal ? 'Final' : `${funnel.totalLabel} total`}
            </span>
          </div>

          <div className={styles.funnelBody}>
            {barWithheld === null ? (
              <div className={styles.funnelBar} role="img" aria-label={funnel.barLabel}>
                {funnel.segments.map((segment) => (
                  <div
                    key={segment.key}
                    className={styles.funnelSeg}
                    data-state={segment.key}
                    style={{ width: `${segment.widthPercent}%` }}
                  />
                ))}
              </div>
            ) : (
              <p className={styles.funnelEmpty}>{barWithheld}</p>
            )}

            {/*
              The track count comes from the cell count. The key is a row of
              equals and `contactFunnel` lists five states or six depending on
              whether contacts are on a call, so a fixed five tracks put the
              sixth cell alone on a second row at a fifth of the width — see
              the stylesheet's own note above `.funnelKey`.
            */}
            <div
              className={styles.funnelKey}
              data-testid="contact-funnel-key"
              data-count={funnel.cells.length}
            >
              {funnel.cells.map((cell) => (
                <div
                  key={cell.key}
                  className={styles.funnelKeyCell}
                  data-testid={`contact-state-${cell.key}`}
                >
                  <div className={styles.funnelKeyHead}>
                    <span className={styles.swatch} data-state={cell.key} />
                    <span className={styles.funnelKeyLabel}>{cell.label}</span>
                  </div>
                  <div className={styles.funnelKeyValue} data-known={String(cell.count !== null)}>
                    {cell.derived ? (
                      <span
                        className={styles.derivedMark}
                        title="Worked out from the other counts, not reported directly."
                      >
                        {cell.value}
                      </span>
                    ) : (
                      cell.value
                    )}
                    {cell.percentLabel && (
                      <span className={styles.funnelKeyPct}>{cell.percentLabel}</span>
                    )}
                  </div>
                  <span className={styles.hint}>{cell.hint}</span>
                </div>
              ))}
            </div>

            {/*
              "Waiting" reads as "dialable now" and a queued retry is not.
              Stated beneath the state it qualifies rather than as a sixth
              counter, which is what it used to be.
            */}
            {retries && (
              <p className={styles.retriesNote}>
                <RefreshCw size={16} aria-hidden="true" />
                <span>{retries}</span>
              </p>
            )}

            {/*
              A contact still marked as being on a call, on a campaign that has
              stopped. The panel above is badged "Final" and the rail beside it
              reports nobody on the line and no lines in use, so this row is
              the one place those three can be seen to disagree.
            */}
            {stuck && (
              <p className={styles.stuckNote}>
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{stuck}</span>
              </p>
            )}
          </div>
        </section>

        {/*
          ── Zone C · the rail ─────────────────────────────────────────────
          It renders on EVERY status. Removing it once a campaign stopped is
          what left the page one narrow column with a screen of white beside
          it — and a stopped campaign is the primary case for this panel, not
          an edge of it. What changes with the status is its contents: nobody
          is on the floor of a stopped campaign, so that block is omitted and
          the heading names what is left.
        */}
        <aside
          className={`${styles.card} ${styles.rail}`}
          aria-labelledby="account-guardrails-heading"
        >
          <div className={`${styles.cardHead} ${styles.railHeadBlock}`}>
            <div>
              <h2 className={styles.cardTitle} id="account-guardrails-heading">
                {terminal ? 'The account right now' : 'Right now'}
              </h2>
              <p className={styles.cardDesc}>
                {terminal
                  ? 'Live account-wide limits. These describe the account today, not this campaign.'
                  : 'The live floor, and the limits this campaign shares with the account.'}
              </p>
            </div>
            <Activity size={18} className={styles.railIcon} aria-hidden="true" />
          </div>

          {!terminal && (
            <>
              <div className={`${styles.railRow} ${styles.railRowFirst}`} data-testid="floor-summary">
                <div className={styles.railHead}>
                  <span className={styles.kicker}>Agents on shift</span>
                  <span className={styles.railValue} data-known={String(floor.known)}>
                    {floor.onShiftLabel}
                  </span>
                </div>

                {floor.slices.length > 0 && (
                  <>
                    <div className={styles.stateBar} role="img" aria-label={floor.shiftSub ?? ''}>
                      {floor.slices.map((slice) => (
                        <div
                          key={slice.state}
                          className={styles.stateBarSeg}
                          data-state={slice.state}
                          style={{ width: `${slice.percent}%` }}
                        />
                      ))}
                    </div>
                    <div className={styles.stateKey}>
                      {floor.slices.map((slice) => (
                        <span key={slice.state} className={styles.stateKeyItem}>
                          <span className={styles.swatch} data-state={slice.state} />
                          <span>{slice.label}</span>
                          <span>{slice.count.toLocaleString()}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}

                {/*
                  An unread floor and an empty one are different facts and
                  only one of them is news. A zero with no breakdown behind it
                  says nothing at all, so it says nothing.
                */}
                {!floor.known && (
                  <span className={styles.hint}>The live floor didn’t load.</span>
                )}
                {floor.known && floor.slices.length === 0 && floor.onShift === 0 && (
                  <span className={styles.hint}>
                    Nobody is at a station on this campaign right now.
                  </span>
                )}
              </div>
              <div className={styles.divider} />
            </>
          )}

          <div className={styles.railReadouts}>
            <CampaignHealthStrip
              stats={stats}
              mode="readouts"
              campaignId={campaign.id}
              campaignStatus={campaign.status}
              role={role}
              finished={terminal}
            />
          </div>

          {/*
            ── "How it ended" ────────────────────────────────────────────
            ABOVE "How it ran", because on a campaign that has stopped the
            first question is when it ended and who ended it — a supervisor
            opening this page is usually asking whether the dialer stopped
            itself. The calling window below is context for that answer, not
            a competitor to it.

            Terminal only. On a live campaign the same facts are the header's
            "Running for …", and a rail block quoting an end time that has
            not happened yet would contradict the Stop button above it.
          */}
          {howItEnded.length > 0 && (
            <>
              <div className={styles.divider} />
              <div className={styles.railRow} data-testid="how-it-ended">
                <span className={styles.kicker}>How it ended</span>
                <div className={styles.howItRan}>
                  {howItEnded.map((line) => (
                    <div key={line.label} className={styles.railHead}>
                      <span className={styles.hint}>{line.label}</span>
                      <span className={styles.howItRanValue}>{line.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/*
            The campaign's own settings, restated where the numbers they
            explain are being read. A campaign that looks idle at 7pm was
            outside its calling window; a wrap-up allowance is the difference
            between an agent being free and being on shift. These come off the
            campaign row, so they survive a terminal campaign — which is the
            case the block was written for.
          */}
          {howItRan.length > 0 && (
            <>
              <div className={styles.divider} />
              <div className={styles.railRow}>
                <span className={styles.kicker}>How it ran</span>
                <div className={styles.howItRan}>
                  {howItRan.map((line) => (
                    <div key={line.label} className={styles.railHead}>
                      <span className={styles.hint}>{line.label}</span>
                      <span className={styles.howItRanValue}>{line.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {/*
        ── Zone D · the time dimension ───────────────────────────────────────
        Every counter above is a lifetime total: they say where the list has
        got to and cannot tell a campaign that has been dialing all week from
        one that woke up an hour ago. This is the panel's answer to "is it
        dialing", so it gets the panel's full width — inside `row2` it would
        be squeezed into the funnel's column, and a day-by-day bar pair read
        at 60% of a screen is a shape nobody can read a trend off.

        It owns its own fetch, range picker and four states, so nothing is
        threaded into it beyond the campaign it is about.
      */}
      <CampaignSeriesSection
        campaignId={campaign.id}
        campaign={campaign}
        chart="activity"
        reloadToken={seriesRefresh}
      />
    </section>

  );
}
