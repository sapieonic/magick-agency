import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useCampaignContribution } from '../../hooks/useCampaignContribution';
import { trackAgencyCampaignContributionViewed } from '../../analytics/events';
import type { NamedAgent } from '../../utils/agencyAgentFloor';
import {
  AGENT_STATS_WINDOWS,
  AGENT_STATS_WINDOW_LABELS,
  campaignLabel,
  windowRangeReadout,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import {
  CONTRIBUTION_SORT,
  CONTRIBUTION_SORT_LABELS,
  contributionAsymmetryNote,
  contributionCampaignOptions,
  contributionCountReadout,
  contributionTruncationNote,
} from '../../utils/agencyCampaignContribution';
import { allRowsHiddenReason } from '../../utils/agencyAgentRoster';
import { ContributionTable } from './ContributionTable';
import { ErrorAlert } from '../common/ErrorAlert';
import { LoadingSpinner } from '../common/LoadingSpinner';
import styles from './AgentAnalyticsSection.module.css';

/**
 * "This campaign went like this, and here is who drove it."
 *
 * ── The question, and why it is a second view rather than a column ─────────
 * The roster answers "who should I be asking about" across the floor. A supervisor
 * whose next sentence is "so who actually drove the Renewals numbers this week"
 * cannot get there from a roster row: a row is that person's whole window against
 * a cohort, and the campaign's own total — the thing a contribution is a share OF
 * — is not on the roster payload at all. This view reads the grouped route for
 * both and puts them on one screen.
 *
 * ── It REPLACES the roster rather than stacking under it ───────────────────
 * Exactly as the per-agent drill-down does, and for the same two reasons: the
 * campaign's contribution and the ranked floor are two answers to two questions
 * and stacking them invites reading one as a continuation of the other, and
 * mounting both would pay for a surface the reader is not looking at. Entering
 * unmounts the roster's controls, so nothing here can make the roster refetch
 * behind it.
 *
 * ── Its window and its toggle are its OWN state, seeded from the roster's ──
 * Seeded, so arriving here does not silently change the range the reader was
 * looking at — the same defect the drill-down had when it defaulted to `today`
 * while the roster showed the week. Its own, so moving the window here does not
 * refetch the roster that is no longer on screen. The pattern is
 * `AgentAnalyticsSection`'s `period`, for the same reasons.
 *
 * ── One campaign, required ────────────────────────────────────────────────
 * The caller only offers the way in when a single campaign is in scope. "Who drove
 * this campaign" pooled across an account's campaigns is not a question, and a
 * share of everything is not a contribution — so the premise is a required prop
 * rather than a nullable filter with a guard, and there is no pooled path here to
 * get wrong.
 *
 * ── One campaign, but not the SAME one for the whole visit ─────────────────
 * The campaign is a CONTROLLED prop with a selector beside the window, because a
 * supervisor reviewing four dealerships was otherwise leaving and re-entering this
 * screen four times, re-choosing the window each time. Controlled rather than local
 * state so there is one answer to "which campaign is this" — the caller needs it
 * for the label on the way back out of a person's figures — and because the caller
 * is the only place that can keep the roster's own filter separate from this one.
 *
 * Changing it re-reads and deliberately does NOT reset this view's window or its
 * toggle: comparing four campaigns over one range is the entire reason the control
 * exists, and a range that reset itself per campaign would defeat it. That is also
 * why the caller must not `key` this component by the campaign.
 *
 * ── A row opens one person, and comes back HERE ────────────────────────────
 * `onSelectAgent` is the caller's, for the caller's reason: the panels behind it
 * replace this screen exactly as this screen replaces the roster, so exactly one
 * read is ever in flight. This component does not mount them itself.
 */

export interface CampaignContributionProps {
  campaignId: string;
  /**
   * The campaign names the page already holds.
   *
   * The map rather than a resolved string, so this component uses the same
   * `campaignLabel` stand-in every other agency surface does: an id with no match
   * renders as a shortened id, never blank and never a name this client invented.
   */
  campaignNames: ReadonlyMap<string, string | null>;
  /** The roster's window, as the starting point. */
  period: AgentStatsWindow;
  /** The roster's toggle, as the starting point. */
  includeInactive: boolean;
  /**
   * A different campaign was chosen here.
   *
   * The caller owns {@link campaignId}, so this is how the selector moves it. It
   * must not move the ROSTER's campaign filter: going back has to land on the
   * roster the reader left, not on one they re-scoped from a screen that had
   * replaced it.
   */
  onCampaignChange: (campaignId: string) => void;
  /**
   * Open one person's figures, from their row.
   *
   * The panels are the caller's to mount — they replace this screen, the same way
   * this screen replaces the roster — so what travels up is just who was pressed.
   */
  onSelectAgent: (agent: NamedAgent) => void;
  onBack: () => void;
}

export function CampaignContribution({
  campaignId,
  campaignNames,
  period: initialPeriod,
  includeInactive: initialIncludeInactive,
  onCampaignChange,
  onSelectAgent,
  onBack,
}: CampaignContributionProps) {
  const [period, setPeriod] = useState<AgentStatsWindow>(initialPeriod);
  const [includeInactive, setIncludeInactive] = useState(initialIncludeInactive);

  const { state, reload } = useCampaignContribution({ campaignId, period, includeInactive });
  const name = campaignLabel(campaignId, campaignNames);

  /*
    What the selector may choose. Derived from the one map the page holds, so this
    control and the roster's cannot describe different sets of campaigns — and the
    campaign in scope is always in the list, named or not, because a `<select>`
    whose value matches no option renders blank.
  */
  const campaignOptions = useMemo(
    () => contributionCampaignOptions(campaignId, campaignNames),
    [campaignId, campaignNames],
  );

  const page = state.status === 'ready' || state.status === 'empty' ? state.page : null;
  const total = state.status === 'ready' || state.status === 'empty' ? state.total : null;
  /*
    Rows empty but rows HIDDEN — an ordinary API response rather than a shape
    violation, and a different screen from `empty`: the remedy is the toggle below,
    not a longer window, so it must not render the sentence that says otherwise.

    ── And "hidden" has TWO causes here, exactly as it does on the roster ─────
    This was `rows.length === 0` and said everyone had left the team. The API also
    drops groups it could not attribute to a person at all (`unattributed_omitted`,
    R4's third state), and those the toggle cannot bring back — `include_inactive`
    widens a membership filter and these rows match no membership of any status. On
    this screen the misreading is sharper than on the roster: the campaign's own
    total is pinned in the footer and still counts their calls, so a reader is told
    the whole team resigned while looking at the work they did.
  */
  const hiddenReason = state.status === 'ready' ? allRowsHiddenReason(state.page) : null;
  const allHidden = hiddenReason !== null;
  const asymmetry = page ? contributionAsymmetryNote(page, total) : null;
  /*
    The toggle stays on screen once it has been used, and it is what the asymmetry
    note names as the remedy — so the two conditions are one, and it renders
    directly beneath that sentence. See where it is rendered below.
  */
  const showInactiveToggle = includeInactive || (page?.inactive_omitted ?? 0) > 0;

  /**
   * `agency_campaign_contribution_viewed`, once per campaign in scope.
   *
   * Keyed on the campaign rather than on the mount, because the selector re-reads
   * WITHOUT remounting — the per-agent drill-down can use a bare ref only because
   * its caller keys it by `agent_user_id`. Fired on the ready page rather than on
   * mount, so the honesty fields it carries describe an answer that exists.
   *
   * Moving the window does not re-fire it: the same reason the per-agent view
   * tracks once, and one event per range would make "how often is this screen
   * opened" a count of how often a `<select>` was touched.
   */
  const trackedCampaign = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'ready' && state.status !== 'empty') return;
    if (trackedCampaign.current === campaignId) return;
    trackedCampaign.current = campaignId;
    const tracked = state.page;
    trackAgencyCampaignContributionViewed({
      campaign_id: campaignId,
      window: period,
      rows: tracked.rows.length,
      total_groups: tracked.total_groups,
      total_read: state.total !== null,
      inactive_omitted:
        typeof tracked.inactive_omitted === 'number' ? tracked.inactive_omitted : 0,
      unattributed_omitted:
        typeof tracked.unattributed_omitted === 'number' ? tracked.unattributed_omitted : 0,
      include_inactive: includeInactive,
      // The console's own answer, not three counts for a funnel to re-derive.
      truncated: contributionTruncationNote(tracked) !== null,
    });
  }, [state, campaignId, period, includeInactive]);

  return (
    <>
      <div className={styles.drilldownHeader}>
        {/*
          A button, not browser history: this is component state on a tabbed page
          and there is no URL to go back to. Named after where it goes — the same
          label the per-agent drill-down uses, because it is the same destination.
        */}
        <button
          type="button"
          className={styles.back}
          onClick={onBack}
          data-testid="contribution-back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          All agents
        </button>
        <h3 className={styles.drilldownName}>Who drove {name}</h3>
      </div>

      <p className={styles.description}>
        The campaign’s own numbers, then each agent’s share of them, ranked by{' '}
        {CONTRIBUTION_SORT_LABELS[CONTRIBUTION_SORT]}. There is no team band on this
        screen: a share is a fact about this campaign, and comparing one person against
        the floor is what the ranked roster is for.
      </p>

      <div className={styles.filters} role="group" aria-label="Contribution filters">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="contribution-campaign">
            Campaign
          </label>
          {/*
            No "All campaigns" option, unlike the roster's. A share of every campaign
            in the account is not a contribution — the premise of the screen is one
            campaign, and the Share column's denominator is that campaign's own line.

            Without this control, reviewing four dealerships meant leaving and
            re-entering four times and re-choosing the window each time. Moving it
            keeps the window and the toggle exactly where they were, which is the
            point: four campaigns over ONE range is the comparison being made.
          */}
          <select
            id="contribution-campaign"
            className={styles.control}
            value={campaignId}
            data-testid="contribution-campaign"
            onChange={(event) => onCampaignChange(event.target.value)}
          >
            {campaignOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="contribution-period">
            Window
          </label>
          {/*
            The roster's five windows, from the same `windowRange` — the three
            to-date ones and the two COMPLETED ones, because a weekly review is run
            on a Monday morning and "this week" is then ninety minutes of dials.
            Seeded from whatever the roster was showing, so arriving here does not
            move the range under the reader.
          */}
          <select
            id="contribution-period"
            className={styles.control}
            value={period}
            data-testid="contribution-period"
            onChange={(event) => setPeriod(event.target.value as AgentStatsWindow)}
          >
            {AGENT_STATS_WINDOWS.map((value) => (
              <option key={value} value={value}>
                {AGENT_STATS_WINDOW_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {/*
          `null` rather than an empty paragraph: the readout has nothing true to say
          for a page whose echo carries no campaign, and an empty element with a
          testid is a thing tests can assert the presence of while a reader sees
          nothing.
        */}
        {page && contributionCountReadout(page) && (
          <p className={styles.countReadout} data-testid="contribution-count">
            {contributionCountReadout(page)}
          </p>
        )}

        {/*
          Which DAYS, and in whose zone — read off the echo, like everything else
          here. "This week" names the control; it does not name a range, and this is
          the screen whose conversion rates get quoted in a pay conversation or
          disputed by a dealer. On a Monday morning "this week" also means something
          different every hour.
        */}
        {page && windowRangeReadout(page.from, page.to) && (
          <p className={styles.countReadout} data-testid="contribution-window-range">
            {windowRangeReadout(page.from, page.to)}
          </p>
        )}
      </div>

      {/*
        ⚠️ ABOVE the table, unlike the roster's two notes below it — because this
        one is about how to read what IS on screen: the campaign line and the agent
        rows do not add up to each other, and a caveat met after the reader has
        already added the column up is not a caveat. The truncation note below stays
        below: that one is about what is NOT on screen.
      */}
      {asymmetry && (
        <p className={styles.warning} data-testid="contribution-asymmetry">
          {asymmetry}
        </p>
      )}

      {/*
        And the remedy it NAMES, directly beneath it rather than at the foot of the
        page. It used to be the last element below a 200-row table: a sentence whose
        last clause is "tick the box" is a sentence whose remedy has to be reachable
        from where it is read. It is also what the all-departed screen below points
        at, so one control serves both.

        It stays on screen once used: `inactive_omitted` is 0 by definition while
        former members are shown, so a control rendered only on a non-zero count
        could be switched on and never off again.
      */}
      {showInactiveToggle && (
        <div className={styles.inactiveRow}>
          <label className={styles.toggle} htmlFor="contribution-include-inactive">
            <input
              id="contribution-include-inactive"
              type="checkbox"
              checked={includeInactive}
              data-testid="contribution-include-inactive"
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            Show former team members
          </label>
        </div>
      )}

      {state.status === 'loading' && (
        <div className={styles.centred} data-testid="contribution-loading">
          <LoadingSpinner />
        </div>
      )}

      {state.status === 'error' && (
        /* A failure with a retry — a different fact from "nobody dialled it", and
           an empty table for both is how a supervisor concludes a campaign did
           nothing. */
        <div data-testid="contribution-error">
          <ErrorAlert message={state.message} onRetry={reload} />
        </div>
      )}

      {state.status === 'empty' && (
        <p className={styles.empty} data-testid="contribution-empty">
          Nobody was handed a call on {name} in this window, so there is nothing to
          attribute. Try a longer window.
        </p>
      )}

      {/* Three arms, because the remedy differs and one of the three has none. */}
      {hiddenReason === 'departed' && (
        <p className={styles.empty} data-testid="contribution-all-departed">
          Everyone who dialled {name} in this window has since left the team, so every row
          was hidden. Tick “Show former team members” to see them.
        </p>
      )}

      {hiddenReason === 'unattributed' && (
        <p className={styles.empty} data-testid="contribution-all-unattributed">
          Nobody who dialled {name} in this window could be matched to a member of this
          team, so every row was dropped. “Show former team members” will not reveal them
          — these rows carry no membership record of any kind, which is a different thing
          from having left. Their calls are still in the campaign’s own total.
        </p>
      )}

      {hiddenReason === 'both' && (
        <p className={styles.empty} data-testid="contribution-all-hidden">
          Every row was dropped: some of the people who dialled {name} in this window have
          since left the team, and the rest could not be matched to a member of it at all.
          Tick “Show former team members” to see the ones who left; the others have no
          membership record to reveal.
        </p>
      )}

      {state.status === 'ready' && !allHidden && (
        <ContributionTable
          page={state.page}
          total={state.total}
          campaignName={name}
          onSelect={onSelectAgent}
          /*
            The order comes off the ECHO, with the wire value as the last resort —
            the same `?? ` the truncation note carries, and for the same reason: an
            echo this build's vocabulary does not know would otherwise caption the
            table "ranked by undefined" under version skew.
          */
          caption={`Who drove ${name} — ${AGENT_STATS_WINDOW_LABELS[
            period
          ].toLowerCase()}, ranked by ${
            CONTRIBUTION_SORT_LABELS[state.page.sort] ?? state.page.sort
          }`}
        />
      )}

      {/*
        The campaign line failed on its own. Said here rather than only in the
        footer's own cell, because it changes how the whole Share column reads —
        and it is a failure with a retry, not an absence to live with.

        ── The retry is now real ────────────────────────────────────────────────
        This paragraph called itself retryable and offered nothing: the only Retry on
        the surface was inside the rows-error branch, which by construction is not
        the branch being rendered here. So the one recoverable failure on the screen
        was the one with no way to recover from it, described as though there were.
        `reload` re-reads BOTH statements, which is correct rather than wasteful —
        they are one answer (the Share column divides one by the other), and re-reading
        only the total would pair a fresh campaign line with rows from an older
        moment.
      */}
      {state.status === 'ready' && state.totalFailed && (
        <p className={styles.note} data-testid="contribution-total-failed">
          The campaign’s own total could not be read, so nothing on this page says what
          share of it each agent took.{' '}
          <button
            type="button"
            className={styles.retryInline}
            data-testid="contribution-total-retry"
            onClick={reload}
          >
            Try reading it again
          </button>
        </p>
      )}

      {page && contributionTruncationNote(page) && (
        <p className={styles.note} data-testid="contribution-truncated">
          {contributionTruncationNote(page)}
        </p>
      )}

    </>
  );
}

export default CampaignContribution;
