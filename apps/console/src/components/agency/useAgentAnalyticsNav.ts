import { useCallback, useEffect, useState } from 'react';
import type { AgentStatsWindow } from '../../utils/agencyAgentPerformance';
import type { NamedAgent } from '../../utils/agencyAgentFloor';

/**
 * Which screen the per-agent analytics section is showing, and the drill-down's
 * window: the person opened from a list, the campaign whose contribution or best
 * hours are being read, and the period the person's tiles show.
 *
 * Out of `AgentAnalyticsPanel`, which keeps the roster's own filters and the
 * compare tray. The branch order there (person, then contribution, then best
 * hours, then the roster) is what makes "back" land where the reader came from;
 * this hook only holds the state those branches read.
 *
 * @param rosterWindow the roster's window, which the drill-down inherits
 */
export function useAgentAnalyticsNav(rosterWindow: AgentStatsWindow) {
  /**
   * The person being drilled into, or `null` for whichever list is showing.
   *
   * A {@link NamedAgent} — an id and the name the API resolved — because that is
   * exactly what the drill-down uses, and re-deriving the name would mean either a
   * second lookup or a blank caption. It used to be the whole roster row, and the
   * row's other twenty fields were never read: widening it to the two that are is
   * what lets a CONTRIBUTION row open the same panels without fabricating a roster
   * row's shape to do it.
   *
   * Either list can set it, so the two drill-downs are no longer mutually
   * exclusive — see the branch order in `AgentAnalyticsPanel`, which is what
   * makes "back" land where the reader came from.
   */
  const [selected, setSelected] = useState<NamedAgent | null>(null);

  /**
   * The campaign whose contribution is being read, or `null` for the roster.
   *
   * The ID rather than a boolean, so the view has a definite campaign of its own:
   * "who drove this campaign" is a question about ONE campaign, and a view that
   * read the filter live could be re-scoped by a control it does not render.
   *
   * A second drill-down beside {@link selected}. Both replace the roster rather
   * than stacking under it, which is what keeps exactly one read in flight and
   * stops the roster refetching behind a screen nobody is looking at — but they are
   * no longer mutually exclusive, because a contribution row opens a person. When
   * both are set the PERSON is on screen and this is what they return to; see the
   * branch order in `AgentAnalyticsPanel`.
   *
   * It is also the campaign the contribution view is showing, not merely the one it
   * was opened with: that view's selector reports through `onCampaignChange`, so
   * there is one answer to "which campaign is this" and the label on the way back
   * out of a person's figures can be right.
   */
  const [contributionCampaign, setContributionCampaign] = useState<string | null>(null);

  /**
   * The campaign whose best-hours map is being read, or `null` for the roster.
   *
   * A THIRD screen beside {@link contributionCampaign}, and its own piece of state
   * for the same reason that one is: "when does this campaign connect" is a question
   * about ONE campaign — the read is a 400 without one, because both time dimensions
   * are grouped and the zone is unambiguous only under a single campaign filter — and
   * a view that read the roster's filter live could be re-scoped by a control it does
   * not render.
   *
   * It is mutually exclusive with the contribution screen in practice: both replace
   * the roster, and each is entered from the roster's header, so only one can be set
   * at a time. Written as two independent pieces of state rather than one
   * discriminated union because the union's third arm would exist only to say which
   * of two screens is showing, and `AgentAnalyticsPanel`'s branch order already says that.
   *
   * Unlike the contribution screen, this one has no way into a person's figures: a
   * weekday-hour cell is not somebody, so there is nothing on it to open. That is why
   * `SelectedAgent`'s back label does not mention it.
   */
  const [bestHoursCampaign, setBestHoursCampaign] = useState<string | null>(null);

  /**
   * Which period the drill-down's tiles are showing.
   *
   * Held in this hook, above the panel's `key={agent_user_id}` remount, for the same reason it
   * was before the roster existed: "this week" means the same thing whoever is being
   * looked at, and resetting it would fight a supervisor comparing two people over
   * one range.
   *
   * ── It INHERITS the roster's window rather than starting at `today` ────────
   * It used to default to `today` while the roster defaulted to the week, so a
   * row's numbers changed the moment it was opened — the same person, two ranges,
   * one click apart, with nothing on screen saying so. It now follows the roster's
   * window: seeded from it, and re-seeded whenever the reader moves it.
   *
   * That inheritance is now EXACT. It used to run through `windowPeriod`, which
   * folded `last_week` onto "this week" and `last_month` onto "this month",
   * because the panel only had the three to-date tiles — so a supervisor who
   * ranked the floor on last week and opened a row was shown this week's figures
   * for that person, under a heading that still said the roster's window. The
   * panel now renders all five, so the mapping is gone and the drill-down lands
   * on the range the roster was ranked by.
   *
   * Changing the TILE afterwards still sticks across a change of person, which is
   * what a supervisor comparing two people over one range needs.
   */
  const [period, setPeriod] = useState<AgentStatsWindow>('week');
  useEffect(() => {
    setPeriod(rosterWindow);
  }, [rosterWindow]);

  /**
   * Open a person, and re-seed their panel's window from the roster's.
   *
   * ── Why the effect above is not enough ────────────────────────────────────
   * It re-seeds only when `filters.period` CHANGES. So: rank the week, open Priya,
   * switch her tiles to Today, go back. The roster header still says "This week" —
   * and it is telling the truth, the table really is a week — but `period` is now
   * `today`, so the next row opened shows Today's figures under a header one click
   * away that says This week. Two ranges on one screen, no control saying which is
   * which, and the discrepancy reads as the console disagreeing with itself.
   *
   * Re-seeding on the way IN fixes it at the only moment it can be observed: the
   * panel is the sole reader of `period`, so the invariant to hold is "the panel
   * opens on the roster's window", not "period equals the roster's window at all
   * times". Doing it here rather than in `onBack` puts one write on the path into
   * the screen that shows the value, instead of a second write on the way out of it
   * that nothing could observe.
   *
   * It costs the previous behaviour where a chosen tile stuck across a change of
   * person, and that is the ruling: a supervisor comparing two people over one range
   * can still move the tile on each, and having the panel silently contradict the
   * table it was opened from is the worse of the two.
   */
  const openAgent = useCallback(
    (agent: NamedAgent) => {
      // Exactly the roster's window — no longer folded onto a to-date sibling,
      // because the panel renders all five.
      setPeriod(rosterWindow);
      setSelected(agent);
    },
    [rosterWindow],
  );

  return {
    selected,
    setSelected,
    contributionCampaign,
    setContributionCampaign,
    bestHoursCampaign,
    setBestHoursCampaign,
    period,
    setPeriod,
    openAgent,
  };
}
