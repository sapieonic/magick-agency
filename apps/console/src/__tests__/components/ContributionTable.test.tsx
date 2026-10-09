import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { ContributionTable } from '../../components/agency/ContributionTable';
import {
  campaignTotalRow,
  contributionPage,
  contributionRow,
  hollowContributionRow,
  thinContributionRow,
} from '../helpers/contribution';
import type { AgencyGroupRowWithName } from '../../types/agency-stats';
import type { NamedAgent } from '../../utils/agencyAgentFloor';

/**
 * The contribution table, rendered from props — no hook, no network.
 *
 * ── The property the whole file is about ──────────────────────────────────
 * The pinned footer is the CAMPAIGN's own line, read separately, and it is
 * deliberately not the sum of the rows above it. A table is scanned rather than
 * read, so the cases below assert both halves of that: the footer shows the
 * campaign's real figures, and the rows show a share of them that does not have
 * to reach 100%.
 *
 * `CampaignContribution.test.tsx` covers the wiring — what is asked for, and the
 * sentence that explains the gap.
 */

function renderTable(
  page = contributionPage(),
  total: ReturnType<typeof campaignTotalRow> | null = campaignTotalRow(),
  onSelect: ((agent: NamedAgent) => void) | undefined = undefined,
) {
  render(
    <ContributionTable
      page={page}
      total={total}
      campaignName="Renewals"
      caption="Who drove Renewals"
      onSelect={onSelect}
    />,
  );
}

afterEach(() => cleanup());

describe('ContributionTable — the campaign, then who drove it', () => {
  it('pins the campaign’s OWN figures, named as the campaign', () => {
    /**
     * Labelled "This campaign · Renewals · everyone who dialled it" rather than
     * "Total": this line is the denominator of the Share column, and a footer
     * called "Total" leaves a reader to guess whether it totals the rows above it
     * (it does not) or the campaign (it does).
     */
    renderTable();

    const total = screen.getByTestId('contribution-total-row');
    expect(total.textContent).toContain('This campaign');
    expect(total.textContent).toContain('everyone who dialled it');
    expect(within(total).getByText('1,200')).toBeTruthy();
    expect(within(total).getByText('400')).toBeTruthy();
    expect(within(total).getByText('80')).toBeTruthy();
    // The campaign is 100% of itself — the total the Share column adds up to, and
    // seeing it is how a reader notices that the rows do not.
    expect(within(total).getByText('100%')).toBeTruthy();
  });

  it('shows each agent’s share of the campaign, not of the visible rows', () => {
    /**
     * Two rows carrying 24 and 12 of the campaign's 80 conversions are 30% and 15%
     * — they do not sum to 100%, and normalising them so they did would be a
     * different (and false) statement about who drove the campaign.
     */
    renderTable(
      contributionPage({
        rows: [
          contributionRow(),
          contributionRow({
            key: { agent_user_id: 'user-2', campaign_id: 'camp-1' },
            agent_name: 'Priya Nair',
            successes: 12,
          }),
        ],
      }),
    );

    expect(within(screen.getByTestId('contribution-row-user-1')).getByText('30%')).toBeTruthy();
    expect(within(screen.getByTestId('contribution-row-user-2')).getByText('15%')).toBeTruthy();
  });

  it('names an unresolvable agent as an id rather than leaving a blank cell', () => {
    renderTable(
      contributionPage({
        rows: [contributionRow({ agent_name: null, key: { agent_user_id: '4f21ab90-aaaa' } })],
      }),
    );
    expect(screen.getByText('Agent 4f21ab90')).toBeTruthy();
  });

  it('opens the person on the row, handing up only the id and the name', () => {
    /**
     * A row is a way INTO that person's figures, and it needs nothing fabricated to
     * be one: the shared panels behind it are built against a user id and a name,
     * which is exactly what an `agent`-grouped row carries — the id on its `key`,
     * where a grouped row keeps it.
     *
     * The alternative was sending the reader back to the roster to find the same
     * person they were already looking at, which is a thing they would do by hand.
     *
     * The whole name cell is the button, as on the roster, so the row is reachable
     * by keyboard and announced once.
     */
    const onSelect = vi.fn();
    renderTable(contributionPage(), campaignTotalRow(), onSelect);

    const open = screen.getByTestId('contribution-open-user-1');
    expect(open.tagName).toBe('BUTTON');
    expect(open.textContent).toContain('Ravi Kumar');

    fireEvent.click(open);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ agent_user_id: 'user-1', agent_name: 'Ravi Kumar' });
  });

  it('hands up the null name as null, rather than the stand-in it renders', () => {
    /**
     * `agent_name: null` means master could not resolve them, and the drill-down
     * applies the SAME `agentDisplayName` fallback to it. Passing the rendered
     * `Agent 4f21ab90` up instead would look identical here and be a name this
     * client invented the moment anything downstream treated it as one.
     */
    const onSelect = vi.fn();
    renderTable(
      contributionPage({
        rows: [contributionRow({ agent_name: null, key: { agent_user_id: '4f21ab90-aaaa' } })],
      }),
      campaignTotalRow(),
      onSelect,
    );

    fireEvent.click(screen.getByTestId('contribution-open-4f21ab90-aaaa'));
    expect(onSelect).toHaveBeenCalledWith({
      agent_user_id: '4f21ab90-aaaa',
      agent_name: null,
    });
  });

  it('renders a PLAIN cell for a group that is not a person', () => {
    /**
     * An `agent`-grouped row with no `agent_user_id` in its key is a contract
     * violation rather than somebody to open, so there is nothing to drill into. A
     * control that looked identical and led nowhere is worse than a plain cell.
     */
    renderTable(
      contributionPage({ rows: [contributionRow({ agent_name: null, key: {} })] }),
      campaignTotalRow(),
      vi.fn(),
    );

    expect(screen.getByText('Unattributed')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders plain cells when the caller offers no way in', () => {
    // The panels are the caller's to mount, so a table given no handler must not
    // render an affordance for something nothing is listening to.
    renderTable();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ContributionTable — the order is fixed, and says so once', () => {
  it('marks the ranked column and only the ranked column', () => {
    /**
     * These headers are not pressable: the screen asks one question and the answer
     * is one order. `aria-sort="none"` on the other seven would announce seven
     * orders nobody can choose — the inverse of the roster's defect, where every
     * header reported `none` because none of them reported anything.
     */
    renderTable();

    expect(
      screen.getByRole('columnheader', { name: /^Conversions/ }).getAttribute('aria-sort'),
    ).toBe('descending');
    expect(
      screen.getByRole('columnheader', { name: /^Connect rate/ }).getAttribute('aria-sort'),
    ).toBeNull();
  });

  it('puts each rate’s denominator on the header beside it', () => {
    // This read carries no `rates_reportable`, so a thin rate cannot be withheld —
    // what makes it legible is the denominator, and a denominator a reader has to
    // hover for is one most of them never see.
    renderTable();
    expect(
      screen.getByRole('columnheader', { name: /^Conversion rate/ }).textContent,
    ).toContain('of connects');
    expect(screen.getByRole('columnheader', { name: /^Share/ }).textContent).toContain(
      'of the campaign’s conversions',
    );
  });
});

describe('ContributionTable — a thin row is not rated', () => {
  it('does not render the served rate STRINGS anywhere in the row', () => {
    /**
     * The negative assertion is the whole point, and it is the roster's: the rates are
     * still on the payload — `connect_rate_pct: 81.8`, `success_rate_pct: 33.3` — and
     * the server said not to report them. Asserting only that "Not enough calls" is
     * present would still pass if the number were rendered faintly beside it, and a
     * rate rendered faintly is the one that gets read aloud beside a named person on a
     * screen headed "who drove this campaign".
     */
    renderTable(contributionPage({ rows: [thinContributionRow()] }));

    const row = screen.getByTestId('contribution-row-user-thin');
    expect(within(row).getAllByText('Not enough calls').length).toBe(2);
    expect(row.textContent).not.toContain('81.8%');
    expect(row.textContent).not.toContain('33.3%');
  });

  it('shows the RIGHT denominator under each withheld rate', () => {
    // A connect rate is over dials; a conversion rate is over connects. Naming the
    // wrong one is how a supervisor concludes the two columns disagree.
    renderTable(contributionPage({ rows: [thinContributionRow()] }));

    const row = screen.getByTestId('contribution-row-user-thin');
    expect(within(row).getByText('11 dials — too few to rate')).toBeTruthy();
    expect(within(row).getByText('9 connects — too few to rate')).toBeTruthy();
  });

  it('names the threshold once per cell, over THAT cell’s own denominator', () => {
    /**
     * Rewritten, because it asserted the defect.
     *
     * It used to expect two tooltips both matching `/Fewer than 20 calls/` — the
     * literal this component (and the roster, and the tray) hand-wrote. "Calls" is
     * not a denominator this surface uses anywhere else: it says **dials** for an
     * attempt and **connects** for an answered call, in the columns, the sublines and
     * the notes. Asserting the vague word made the test agree with the code and
     * neither of them with the screen.
     *
     * This row has 11 dials and 9 connects, so BOTH rates are withheld and the two
     * tooltips must name different numbers. On the 41-dial/11-connect row below it
     * matters more sharply still: only the conversion rate is withheld there, and a
     * tooltip saying "calls" points the reader at forty-one dials and invites them to
     * conclude the console is wrong.
     *
     * The threshold is still named once per CELL rather than in the column header,
     * which is the property the old title was about: a column of repeated sentences
     * is one nobody reads.
     */
    renderTable(contributionPage({ rows: [thinContributionRow()] }));

    const row = screen.getByTestId('contribution-row-user-thin');
    expect(within(row).getAllByTitle(/Fewer than 20 dials/).length).toBe(1);
    expect(within(row).getAllByTitle(/Fewer than 20 connects/).length).toBe(1);
    // And never the word that named neither.
    expect(within(row).queryAllByTitle(/Fewer than 20 calls/).length).toBe(0);
  });

  it('keeps the counts, the Share and the AHT a thin row does have', () => {
    /**
     * Withholding the rates must not blank the row. The counts are what show WHY they
     * were withheld, AHT is a duration rather than a rate, and Share's denominator is
     * the CAMPAIGN's 80 conversions — so `3 / 80` is an exact contribution, which is
     * the only question this screen asks.
     */
    renderTable(contributionPage({ rows: [thinContributionRow()] }));

    const row = screen.getByTestId('contribution-row-user-thin');
    expect(within(row).getByText('11')).toBeTruthy();
    expect(within(row).getByText('9')).toBeTruthy();
    expect(within(row).getByText('3.8%')).toBeTruthy();
    expect(within(row).getByText('1:15')).toBeTruthy();
  });

  it('withholds the CONVERSION rate alone on a row with dials but few connects', () => {
    /**
     * ⚠️ The row this pass exists for, and the negative assertion is again the whole
     * point. 41 dials clears the dial threshold, so `26.8%` is quotable and is on
     * screen. 11 connects does not clear it, so `18.2%` — the served
     * `success_rate_pct`, still on the payload — must appear NOWHERE in the row.
     * Asserting only that "Not enough calls" is present would pass with the number
     * rendered faintly beside it, and a rate rendered faintly is the one that gets
     * read aloud beside a named person.
     *
     * Exactly one cell is withheld, which is the half a single `rates_reportable`
     * gate could not express: gating both rates on dials showed `18.2%`, and gating
     * both on connects would have hidden a connect rate built from 41 dials.
     */
    renderTable(contributionPage({ rows: [hollowContributionRow()] }));

    const row = screen.getByTestId('contribution-row-user-hollow');
    expect(within(row).getByText('26.8%')).toBeTruthy();
    expect(row.textContent).not.toContain('18.2%');
    expect(within(row).getAllByText('Not enough calls')).toHaveLength(1);
    expect(within(row).getByText('11 connects — too few to rate')).toBeTruthy();
    // And every figure that does not divide by connects stays: the counts that show
    // WHY, the duration, and the share of the campaign's own 80.
    expect(within(row).getByText('41')).toBeTruthy();
    expect(within(row).getByText('2.5%')).toBeTruthy();
    expect(within(row).getByText('1:36')).toBeTruthy();
  });

  it('withholds nothing when the field is absent — core may predate it', () => {
    /**
     * Merge order is core → master → cusui. Meeting a core without the field must
     * leave this screen exactly as it was, not turn every rate into "Not enough
     * calls" — which would be a worse screen than the gap the field closed.
     */
    const legacy = contributionRow();
    delete (legacy as Partial<AgencyGroupRowWithName>).rates_reportable;
    renderTable(contributionPage({ rows: [legacy] }));

    const row = screen.getByTestId('contribution-row-user-1');
    expect(within(row).queryByText('Not enough calls')).toBeNull();
    expect(within(row).getByText('33.8%')).toBeTruthy();
    expect(within(row).getByText('22.2%')).toBeTruthy();
  });
});

describe('ContributionTable — absences', () => {
  it('says the campaign line is missing ONCE rather than once per row', () => {
    /**
     * Seven em dashes read as seven separately absent figures; this is one absent
     * READ. So the footer says it once, in a cell spanning the metrics, and the rows
     * above are unaffected and stay on screen.
     *
     * ── The Share cells go BARE, and that is the fix ─────────────────────────
     * Each of them used to carry `No campaign total to divide by`. On a forty-agent
     * campaign that is the same sentence forty times, in a column nobody reads —
     * and it buries the two places that can act on it: this footer, and the
     * paragraph with a retry that `CampaignContribution` renders. A row is not the
     * place to explain a failure of the page.
     */
    renderTable(contributionPage({ rows: [contributionRow(), thinContributionRow()] }), null);

    const missing = screen.getByTestId('contribution-total-missing');
    expect(missing.textContent).toContain('could not be read');
    expect(screen.getAllByText(/could not be read/)).toHaveLength(1);

    // Said nowhere in a row — not in the old words, and not in any others.
    const row = screen.getByTestId('contribution-row-user-1');
    expect(within(row).queryByText('No campaign total to divide by')).toBeNull();
    expect(row.textContent).not.toContain('campaign total');
    expect(row.textContent).toContain('—');
    // Both rows still render, with every figure that does not need the campaign's
    // line: this is a degraded page, not a failed one.
    expect(within(row).getByText('320')).toBeTruthy();
    expect(screen.getByTestId('contribution-row-user-thin')).toBeTruthy();
  });

  it('renders an em dash and a phrase for a rate with no denominator', () => {
    renderTable(
      contributionPage({
        rows: [
          contributionRow({
            connected: 0,
            successes: 0,
            success_rate_pct: null,
            aht_seconds: null,
          }),
        ],
      }),
    );

    const row = screen.getByTestId('contribution-row-user-1');
    expect(within(row).getByText('No connect to convert yet')).toBeTruthy();
    expect(within(row).getByText('No call has finished')).toBeTruthy();
    /*
      The two absences and the one real zero, on ONE row — which is the sharpest
      version of this surface's rule. This agent's SHARE is a true 0%: the campaign
      booked eighty and they booked none of them. Their conversion RATE is not
      measurable at all, because they reached nobody to convert. Rendering the
      second as `0%` too would collapse "took no calls" into "took calls and failed",
      so there is exactly one `0%` in this row and it is the share.
    */
    expect(within(row).getAllByText('0%')).toHaveLength(1);
  });

  it('renders a real 0 as 0%', () => {
    // Measured-and-zero is a finding. 108 connects and no bookings on a campaign
    // that booked eighty is exactly the row this screen exists to surface.
    renderTable(
      contributionPage({ rows: [contributionRow({ successes: 0, success_rate_pct: 0 })] }),
    );

    const row = screen.getByTestId('contribution-row-user-1');
    expect(within(row).getAllByText('0%').length).toBe(2);
  });
});
