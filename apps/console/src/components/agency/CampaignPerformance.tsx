import { AlertTriangle, ChartNoAxesCombined } from 'lucide-react';
import {
  connectRateReadout,
  connectsBreakdown,
  conversionRateReadout,
  handleTimeReadout,
  handledCallCost,
  segmentShareText,
  wrapupReadout,
  type ConnectsSegment,
  type PerformanceReadout,
} from '../../utils/agencyCampaignPerformance';
import type { AgencyCampaignStats } from '../../types/agency-campaign';
import styles from './CampaignPerformance.module.css';

/**
 * §C.3's derived figures — connect rate, conversion rate, handle time, wrap-up,
 * where the connected calls went, and what one handled call costs (MAG-151).
 *
 * ── Why these are not tiles ─────────────────────────────────────────────────
 * The eleven counters on the Overview section are observations: core counted
 * rows and the console prints them, and an absent one can only mean the read
 * failed. Every figure here is a *derivation* with a denominator, a set of
 * exclusions, and at least one way to be absent that is a fact about the
 * campaign rather than about the fetch. Rendering them in the same grid as
 * `Contacts` and `Attempts` would give them the same authority as a row count
 * while hiding all of that.
 *
 * ── Why each is now a card with a scale ─────────────────────────────────────
 * They used to be four bare `div`s sharing one bordered panel and one hairline
 * grid, which reads as four columns of a single table — the closest thing on
 * screen to the tile grid the paragraph above says they must not resemble. Each
 * figure now carries the three things that make it readable on its own: the
 * denominator it was measured against, stated in counts; a scale, so the
 * percentage has a length as well as a number; and its caveat, in the card, at
 * full weight.
 *
 * **The two rates are adjacent on purpose and their denominators are why that
 * is safe.** Connect rate is measured over dials, conversion over conversations
 * — a reader who assumes one denominator for both is out by a factor that
 * changes what they do next. The reader IS about to compare them, so the
 * comparison is made available and then made correct, rather than being
 * prevented by separating the cards.
 *
 * ── The component decides nothing ───────────────────────────────────────────
 * Every number, sentence and proportion below comes from
 * `utils/agencyCampaignPerformance.ts`. This file is assembly: it maps a
 * `ReadoutScale` onto markup and a `ConnectsSegment` onto a row. Nothing here
 * computes a share, substitutes a zero, or decides what an absent field means.
 *
 * ── Placement ───────────────────────────────────────────────────────────────
 * Its own section of the campaign workspace (`MAG-166`), between Overview and
 * Agents in the tab order. It used to sit inline beneath the counters and
 * above the floor, on the argument that handle time is what the floor's "on a
 * call too long" warning is measured against, so the `2:14` should be readable
 * from the same screen as the `4:50`.
 *
 * That adjacency is gone — the two are sibling tabs now, and reaching one from
 * the other is a click. It was paid for by putting four derived figures in the
 * scroll path of every supervisor who opened the page to answer a different
 * question, which is the cost the split was made to stop. The tab order keeps
 * them neighbours, which is the most that survives.
 *
 * ── The by-day trend is a SIBLING of this component, not part of it ─────────
 * "Are the rates holding?" is the question these four figures structurally
 * cannot answer — a campaign whose connect rate fell off a cliff this morning
 * reads identically to one that has been steady all week, because every figure
 * here is a lifetime-to-date aggregate and `AgencyCampaignStats` has no time
 * dimension at all. The series endpoint that does is now built, and
 * `CampaignSeriesSection` draws it: mounted by `AgencyCampaignDetailPage`
 * beside this component on the Performance panel, below it, where it reads as
 * the follow-up to the four figures rather than as a fifth one.
 *
 * **It is deliberately not mounted in here, and the reason is the second call
 * site.** `AgencyAnalyticsPage` renders this component once per campaign inside
 * a list. `CampaignSeriesSection` owns a fetch of its own, so a mount in this
 * file would be one series request — up to 92 daily buckets each — for every
 * row of a page that never asked the question, on top of the per-campaign stats
 * reads that page already makes. The trend belongs to the panel that shows one
 * campaign, so the panel is what mounts it. Anything added here that fetches
 * inherits the same constraint.
 *
 * **It does not replace these four either.** They remain lifetime aggregates
 * measured over the whole campaign, which is exactly what makes them the
 * figures to quote; the chart is measured per DAY and is a shape, not a total.
 * A day is also a far smaller denominator, which is why the chart withholds one
 * whose own denominator falls under `RATE_MIN_ATTEMPTS` — the same threshold
 * these cards publish against, imported by `utils/agencyCampaignSeries.ts`
 * rather than restated, so the two halves of one panel cannot disagree about
 * whether a figure is publishable. That module's docstring sets out why the
 * per-day application of it is the right one; it is not repeated here.
 */

export interface CampaignPerformanceProps {
  /** Null while the first load is in flight, or when the stats read failed. */
  stats: AgencyCampaignStats | null;
  /**
   * The campaign's configured wrap-up window, for the measured average to be
   * read against. Optional on `AgencyCampaign`, so it may be absent.
   */
  wrapupSeconds?: number | null;
}

/** The bar colour for each bucket of the split — one colour per key, everywhere. */
const SEGMENT_FILL: Record<ConnectsSegment['key'], string> = {
  human: styles.segHuman!,
  machine: styles.segMachine!,
  unclassified: styles.segUnclassified!,
};

/**
 * The scale under a figure.
 *
 * Three shapes rather than one meter with a colour prop, because they are three
 * different claims: a share of a real denominator, a share of a configured
 * allowance with the allowance marked, and two figures against each other. The
 * union is decided in the pure module; this only draws it.
 */
function Scale({ scale }: { scale: NonNullable<PerformanceReadout['scale']> }) {
  if (scale.kind === 'fill') {
    return (
      <div className={styles.meter}>
        <span
          className={`${styles.meterFill} ${scale.tone === 'teal' ? styles.fillTeal : styles.fillAccent}`}
          style={{ width: `${scale.percent}%` }}
        />
      </div>
    );
  }

  if (scale.kind === 'ceiling') {
    return (
      // Not `.meter`: the tick overhangs the track top and bottom, so this one
      // must not clip its children.
      <div className={styles.meterTrack}>
        <span
          className={`${styles.meterFill} ${styles.fillWarning}`}
          style={{ width: `${scale.percent}%` }}
        />
        <span className={styles.meterCeiling} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={styles.compare}>
      {scale.bars.map((bar) => (
        <div className={styles.compareRow} key={bar.label}>
          <span className={styles.compareTrack}>
            <span
              className={`${styles.meterFill} ${bar.muted ? styles.fillMuted : styles.fillAccent}`}
              style={{ width: `${bar.percent}%` }}
            />
          </span>
          <span className={styles.compareLabel}>{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

function Readout({
  label,
  testId,
  readout,
}: {
  label: string;
  testId: string;
  readout: PerformanceReadout;
}) {
  return (
    <section
      className={`${styles.card} ${styles.readout}`}
      aria-label={label}
      data-testid={testId}
      data-known={readout.known ? 'true' : 'false'}
    >
      <span className={styles.kicker}>{label}</span>
      {/*
        An unknown value is dimmed, never coloured as a warning. "We couldn't
        read this" and "this number is bad" look nothing alike to a supervisor
        scanning for the second one — and neither does "we are not publishing a
        percentage over eleven dials", which lands in the same state.
      */}
      <span className={readout.known ? styles.readoutValue : styles.readoutValueUnknown}>
        {readout.value}
      </span>
      {/*
        The denominator, in counts, directly under the figure. This is the line
        that stops the two rates being compared as though they shared one.
      */}
      {readout.denominator && (
        <span className={styles.readoutDenom} data-testid={`${testId}-secondary`}>
          {readout.denominator.lead && (
            <strong className={styles.denomLead}>{readout.denominator.lead}</strong>
          )}
          {readout.denominator.lead ? ' ' : ''}
          {readout.denominator.rest}
        </span>
      )}
      {readout.scale && <Scale scale={readout.scale} />}
      <span className={styles.readoutDetail}>{readout.detail}</span>
      {/*
        On screen at full weight rather than behind a tooltip. A caveat that has
        to be hovered to be found is a caveat the number gets quoted without.
      */}
      {readout.caveat && (
        <span className={styles.caveat} data-testid={`${testId}-caveat`}>
          <AlertTriangle size={13} className={styles.caveatIcon} aria-hidden="true" />
          {readout.caveat}
        </span>
      )}
    </section>
  );
}

export function CampaignPerformance({ stats, wrapupSeconds }: CampaignPerformanceProps) {
  const connectRate = connectRateReadout(stats);
  const conversionRate = conversionRateReadout(stats);
  const handleTime = handleTimeReadout(stats);
  const wrapup = wrapupReadout(stats, wrapupSeconds);
  const breakdown = connectsBreakdown(stats);
  const cost = handledCallCost(stats);

  /*
    A bucket with no share contributes no width. The campaign whose catalog has
    no voicemail code has a structural `0` there, and a zero-width segment in a
    `gap: 2px` flex row is not nothing — it is a 2px gap the reader counts as a
    fourth thing. Filtering keeps the bar's parts and the key's rows in
    agreement about what was measured.
  */
  const barSegments = breakdown.segments.filter((s) => s.share !== null && s.share > 0);

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Performance</h2>
          <p className={styles.description}>Quality and efficiency once calls start completing.</p>
        </div>
        <ChartNoAxesCombined size={18} className={styles.headerIcon} aria-hidden="true" />
      </div>

      <div className={styles.readouts}>
        <Readout label="Connect rate" testId="connect-rate-readout" readout={connectRate} />
        {/*
          Immediately after the connect rate, and labelled with its own
          denominator. The two rates on this payload are measured over DIFFERENT
          denominators — connect over dials, conversion over conversations — so
          they must never sit side by side as two bare percentages. Adjacency is
          the right placement precisely because the reader is about to compare
          them; the denominator lines are what stop the comparison being a wrong
          one.
        */}
        <Readout
          label="Conversion of conversations"
          testId="conversion-rate-readout"
          readout={conversionRate}
        />
        <Readout label="Handle time" testId="handle-time-readout" readout={handleTime} />
        <Readout label="Wrap-up" testId="wrapup-readout" readout={wrapup} />
      </div>

      {/*
        Skipped entirely when neither card has anything to say, rather than left
        as an empty grid: the section's own `gap` would then open 16px of blank
        space under the readouts on exactly the campaign — nothing dialled,
        nothing averaged — that has the least on screen to explain it.
      */}
      {(breakdown.total !== null || cost) && (
        <div className={styles.row2}>
          {/*
            D1's split, directly beneath the rate it qualifies. The rate counts only
            the first bucket, so a supervisor who reads "18%" and then sees a large
            "Not written up" column has the explanation in the same glance rather
            than concluding the list is dead.

            Bar first, then the rows: the proportion is the finding and the counts
            are the evidence for it. Three equal boxes — what this was — made the
            three buckets look comparable in size whatever their values.
          */}
          {breakdown.total !== null && (
            <section
              className={styles.card}
              aria-label="Where the connected calls went"
              data-testid="connects-breakdown"
            >
              <div className={styles.cardHead}>
                <div>
                  <h3 className={styles.cardTitle}>
                    Where the {breakdown.total.toLocaleString()} connected calls went
                  </h3>
                  <p className={styles.cardDesc}>
                    Only the first bucket feeds the conversion rate above.
                  </p>
                </div>
                <span className={styles.cardTag}>
                  {breakdown.total.toLocaleString()} connected
                </span>
              </div>

              <div className={styles.cardBody}>
                {barSegments.length > 0 && (
                  <div
                    className={styles.splitBar}
                    role="img"
                    aria-label={barSegments
                      .map((s) => `${s.label} ${s.value.toLocaleString()}`)
                      .join('; ')}
                  >
                    {barSegments.map((segment) => (
                      <div
                        key={segment.key}
                        className={`${styles.splitSeg} ${SEGMENT_FILL[segment.key]}`}
                        style={{ width: `${segment.share ?? 0}%` }}
                      />
                    ))}
                  </div>
                )}

                <div className={styles.splitKey}>
                  {breakdown.segments.map((segment) => (
                    <div
                      key={segment.key}
                      className={styles.splitKeyRow}
                      data-testid={`connects-${segment.key}`}
                      data-unmeasured={segment.unmeasured ? 'true' : 'false'}
                    >
                      <span className={styles.splitKeyHead}>
                        <span
                          className={`${styles.swatch} ${SEGMENT_FILL[segment.key]}`}
                          aria-hidden="true"
                        />
                        <span className={styles.splitKeyLabel}>{segment.label}</span>
                      </span>
                      {/*
                        A bucket that cannot be measured shows an em dash, not its
                        structural `0`. `machine_connects` is exactly 0 on a campaign
                        whose disposition list omits the voicemail code — printing that
                        as a count would report "no voicemails reached" about a
                        campaign that has no way to record one. Its share is `null`
                        for the same reason, so the percentage is blanked too.
                      */}
                      <strong
                        className={
                          segment.unmeasured ? styles.splitKeyValueUnmeasured : styles.splitKeyValue
                        }
                        data-testid={`connects-${segment.key}-count`}
                      >
                        {segment.unmeasured ? '—' : segment.value.toLocaleString()}
                      </strong>
                      <span
                        className={styles.splitKeyPct}
                        data-testid={`connects-${segment.key}-share`}
                      >
                        {segmentShareText(segment.share)}
                      </span>
                      <span className={styles.hint}>{segment.hint}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/*
            Beside the split rather than under it: the split says where the
            conversations went, this says what each one costs to have. Rendered
            only when both averages are real measurements — see `handledCallCost`
            for why substituting a zero for a missing one would inflate rather than
            degrade the estimate.
          */}
          {cost && (
            <section
              className={styles.card}
              aria-label="What one handled call costs"
              data-testid="handled-call-cost"
            >
              <div className={styles.cardHead}>
                <div>
                  <h3 className={styles.cardTitle}>What one handled call costs</h3>
                  <p className={styles.cardDesc}>Talk plus wrap-up, per connected call.</p>
                </div>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.costHeadline}>
                  <span className={styles.costTotal}>{cost.total}</span>
                  <span className={styles.readoutDenom}>an agent’s time, per connected call</span>
                </div>

                <div
                  className={styles.costBar}
                  role="img"
                  aria-label={`Talk ${cost.talk.label}, wrap-up ${cost.wrapup.label}`}
                >
                  <div
                    className={`${styles.splitSeg} ${styles.segTalk}`}
                    style={{ width: `${cost.talk.percent}%` }}
                  />
                  <div
                    className={`${styles.splitSeg} ${styles.segWrapup}`}
                    style={{ width: `${cost.wrapup.percent}%` }}
                  />
                </div>
                <div className={styles.legend}>
                  <span className={styles.legendItem}>
                    <span className={`${styles.swatch} ${styles.segTalk}`} aria-hidden="true" />
                    Talk
                    <strong className={styles.legendValue}>{cost.talk.label}</strong>
                  </span>
                  <span className={styles.legendItem}>
                    <span className={`${styles.swatch} ${styles.segWrapup}`} aria-hidden="true" />
                    Wrap-up
                    <strong className={styles.legendValue}>{cost.wrapup.label}</strong>
                  </span>
                </div>

                <div className={styles.divider} />

                <div className={styles.rails}>
                  <div className={styles.railHead}>
                    <span className={styles.readoutDenom}>
                      Conversations per agent-hour, at this cost
                    </span>
                    <span className={styles.railValue} data-testid="cost-per-hour">
                      {cost.perHour}
                    </span>
                  </div>
                  {/*
                    Withheld with the rate it is made of. `winsPerHour` is
                    `perHour × success_rate_pct`, so a conversion rate this console
                    refuses to publish must not reappear here multiplied into a
                    figure with the word "wins" on it.
                  */}
                  {cost.winsPerHour !== null && (
                    <div className={styles.railHead}>
                      <span className={styles.readoutDenom}>
                        Wins per agent-hour, at {cost.conversionRate} conversion
                      </span>
                      <span className={styles.railValueAccent} data-testid="cost-wins-per-hour">
                        {cost.winsPerHour}
                      </span>
                    </div>
                  )}
                </div>

                <span className={styles.costCaveat}>{cost.caveat}</span>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export default CampaignPerformance;
