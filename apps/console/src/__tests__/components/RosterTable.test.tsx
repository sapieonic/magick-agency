import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { RosterTable } from '../../components/agency/RosterTable';
import { hollowRow, rosterBenchmark, rosterPage, rosterRow, thinRow } from '../helpers/roster';
import type { AgencyRosterBenchmark, AgencyRosterPage } from '../../types/agency-stats';

/**
 * The roster table itself, rendered from props — no hook, no network.
 *
 * ── Why these are prop-level rather than reached through the section ───────
 * Every case below is about a rendering RULE that has to hold for a payload the
 * server is allowed to send, and most of those payloads are awkward to produce
 * through a mocked fetch: a cohort of one rated agent, a null occupancy on an
 * otherwise fat row, a page whose only row is thin. Constructing them directly is
 * what makes the rules falsifiable instead of merely plausible.
 *
 * `AgentAnalyticsSection.test.tsx` covers the same table end-to-end for the two
 * properties that are genuinely about wiring — the thin-row rule, and that
 * pressing a header refetches.
 *
 * ── The rule the whole file exists for ────────────────────────────────────
 * **A table is scanned, not read.** `0%` sitting in a column of real percentages
 * is indistinguishable from a bad week, so the negative assertions here matter as
 * much as the positive ones: several cases assert that a number is NOT on screen,
 * which is the only way to pin "we did not quietly render the figure faintly".
 */

function renderTable(
  page: AgencyRosterPage,
  onSelect = vi.fn(),
  onSort = vi.fn(),
  onlyFlagged = false,
) {
  render(
    <RosterTable
      page={page}
      sort={page.sort}
      order={page.order}
      onSort={onSort}
      onSelect={onSelect}
      onlyFlagged={onlyFlagged}
      caption="Everyone who dialled"
    />,
  );
  return { onSelect, onSort };
}

afterEach(() => cleanup());

describe('RosterTable — a thin row is not rated', () => {
  it('renders WORDS instead of the served rate', () => {
    /**
     * The rates are still on the payload — `connect_rate_pct: 100`,
     * `success_rate_pct: 27.3` — and the server told us not to report them. So the
     * table prints "Not enough calls", not a greyed-out percentage: a rate rendered
     * faintly is still a rate, and it is the one that gets read aloud in a coaching
     * conversation.
     */
    renderTable(rosterPage({ rows: [thinRow()] }));

    const row = screen.getByTestId('roster-row-user-thin');
    expect(within(row).getAllByText('Not enough calls').length).toBe(2);
    expect(row.textContent).not.toContain('100%');
    expect(row.textContent).not.toContain('27.3%');
  });

  it('shows the denominator, and the RIGHT denominator per rate', () => {
    // Rates and their denominators travel together — the contract's rule. A connect
    // rate is over dials; a conversion rate is over conversations. Naming the wrong
    // one is how a supervisor concludes the numbers disagree with each other.
    renderTable(rosterPage({ rows: [thinRow({ attempts: 11, connected: 9 })] }));

    const row = screen.getByTestId('roster-row-user-thin');
    expect(within(row).getByText('11 dials — too few to rate')).toBeTruthy();
    expect(within(row).getByText('9 connects — too few to rate')).toBeTruthy();
  });

  it('withholds the CONVERSION rate alone on a row with dials but few connects', () => {
    /**
     * ⚠️ Four hundred dials and three connects. `rates_reportable` counts DIALS, so
     * it does not withhold a rate that divides by CONNECTS — and the served
     * `success_rate_pct` (33.3%, one booking out of three conversations) was printed
     * beside a named person. The negative assertion is the point: the number is still
     * on the payload, and a faintly-rendered rate is the one that gets quoted.
     *
     * The connect rate stays, because its own denominator really is those four
     * hundred dials — `0.8%` is exactly the finding a supervisor needs here, and
     * withholding it would leave the row with nothing to explain itself.
     */
    renderTable(rosterPage({ rows: [hollowRow()] }));

    const row = screen.getByTestId('roster-row-user-hollow');
    expect(within(row).getAllByText('Not enough calls')).toHaveLength(1);
    expect(within(row).getByText('3 connects — too few to rate')).toBeTruthy();
    expect(row.textContent).not.toContain('33.3%');
    expect(within(row).getByText('0.8%')).toBeTruthy();
    // No chip either: the same predicate gates the cell and the comparison, so a row
    // the band excluded is not flagged against it.
    expect(screen.queryByTestId('roster-flag-user-hollow')).toBeNull();
  });

  it('names CONNECTS in the withheld tooltip on a row whose dials were plentiful', () => {
    /**
     * ⚠️ The tooltip said "Fewer than 20 calls" on every withheld cell in all three
     * of these tables. On this row — 400 dials, 3 connects — the conversion rate is
     * withheld for want of CONNECTS, and a reader who hovers it was told the row was
     * short of calls while four hundred dials sat two columns to the left. The
     * sentence explaining a withheld number contradicted the number beside it.
     */
    renderTable(rosterPage({ rows: [hollowRow()] }));

    const row = screen.getByTestId('roster-row-user-hollow');
    expect(within(row).getByTitle(/Fewer than 20 connects/)).toBeTruthy();
    expect(within(row).queryByTitle(/Fewer than 20 calls/)).toBeNull();
    expect(within(row).queryByTitle(/Fewer than 20 dials/)).toBeNull();
  });

  it('names DIALS when it really is the dial count that fell short', () => {
    /**
     * The other direction, so the case above is not passing because the word "dials"
     * was simply removed from the sentence.
     *
     * The `thin` CHIP's own sentence is included: `rates_reportable` is
     * `attempts >= 20`, so dials is its denominator too, and it said "calls" as well.
     * A row cannot carry three words for two quantities — dials in the columns,
     * connects in the cell notes and "calls" in whichever tooltip you happen to
     * hover.
     */
    renderTable(rosterPage({ rows: [thinRow()] }));

    const row = screen.getByTestId('roster-row-user-thin');
    expect(within(row).getAllByTitle(/Fewer than 20 dials/).length).toBeGreaterThanOrEqual(1);
    expect(row.innerHTML).not.toContain('Fewer than 20 calls');
    expect(screen.getByTestId('roster-flag-user-thin').getAttribute('aria-label')).toContain(
      'Fewer than 20 dials',
    );
  });

  it('still shows the countable figures a thin row does have', () => {
    // Withholding the rates must not blank the row. Dials and conversations are
    // counts, not rates, and they are exactly what a supervisor needs in order to
    // see WHY the rates are withheld.
    renderTable(rosterPage({ rows: [thinRow({ attempts: 11, connected: 9 })] }));

    const row = screen.getByTestId('roster-row-user-thin');
    expect(within(row).getByText('11')).toBeTruthy();
    expect(within(row).getByText('9')).toBeTruthy();
  });

  it('flags the row as unratable rather than as underperforming', () => {
    /**
     * `thin` outranks `below_band` deliberately: a rate that is below p25 AND built
     * from eleven calls is not a performance finding, and a chip saying so would
     * start the exact conversation `rates_reportable` exists to prevent.
     */
    renderTable(
      rosterPage({ rows: [thinRow({ connect_rate_pct: 4 })], benchmark: rosterBenchmark() }),
    );

    expect(screen.getByTestId('roster-flag-user-thin').textContent).toBe('Too few to rate');
  });

  it('exposes the flag’s reason to a screen reader, not only to a mouse', () => {
    // The sentence behind the chip used to live in `title` alone — a tooltip on
    // hover, and nothing at all to a screen reader, a keyboard user or a touch
    // screen.
    renderTable(rosterPage({ rows: [thinRow()] }));

    const chip = screen.getByTestId('roster-flag-user-thin');
    expect(chip.getAttribute('role')).toBe('note');
    expect(chip.getAttribute('aria-label')).toContain('Too few to rate');
    expect(chip.getAttribute('aria-label')).toContain('did not count towards');
  });

  it('draws no bullet for a withheld rate', () => {
    // A bar for a rate the table refuses to print in words would put the number
    // back on screen as a length — the same claim in a form nobody can quote but
    // everybody can compare.
    const { container } = render(
      <RosterTable
        page={rosterPage({ rows: [thinRow()] })}
        sort="successes"
        order="desc"
        onSort={vi.fn()}
        onSelect={vi.fn()}
        caption="Everyone who dialled"
      />,
    );
    expect(container.querySelectorAll('[class*="bulletValue"]').length).toBe(0);
  });
});

describe('RosterTable — a null rate is never 0%', () => {
  it('renders an em dash and a phrase for an unmeasured utilisation', () => {
    /**
     * `occupancy_pct: null` on a row with 320 dials is the ordinary case: core's
     * agent-state event log shipped after the dialer, so a session that predates it
     * has no events. Zero and unmeasured are indistinguishable on the wire — which
     * is precisely why this must not print `0%`, because one of the two readings
     * would be a false claim that somebody sat idle through a shift.
     */
    renderTable(
      rosterPage({ rows: [rosterRow({ occupancy_pct: null, shift_seconds: 0, break_seconds: 0 })] }),
    );

    const row = screen.getByTestId('roster-row-user-1');
    expect(within(row).getByText('No shift recorded')).toBeTruthy();
    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toContain('0%');
  });

  it('keeps a phrase for the nulls that ARE reachable', () => {
    /**
     * A row that dialled and reached nobody: `success_rate_pct` and `aht_seconds`
     * are both `null` because their denominator is `connected`, and both are
     * ordinary answers a supervisor needs read back to them.
     *
     * What used to be here was a `attempts: 0` row asserting "No dials in this
     * window" in three places. **That row cannot exist** — core groups over rows
     * filtered on `dialed_at IS NOT NULL`, so `attempts >= 1` always and
     * `connect_rate_pct` is never null. The copy and the tests over it are gone; see
     * `connectRateCell`.
     */
    renderTable(
      rosterPage({
        rows: [
          rosterRow({
            attempts: 40,
            connected: 0,
            successes: 0,
            connect_rate_pct: 0,
            success_rate_pct: null,
            aht_seconds: null,
          }),
        ],
      }),
    );

    const row = screen.getByTestId('roster-row-user-1');
    expect(within(row).getByText('No connect to convert yet')).toBeTruthy();
    expect(within(row).getByText('No call has finished')).toBeTruthy();
    // The connect rate over forty unanswered dials is a real 0 and reads as one.
    expect(within(row).getByText('0%')).toBeTruthy();
    expect(within(row).queryByText('Not enough calls')).toBeNull();
    expect(row.textContent).not.toContain('No dials in this window');
  });

  it('renders a real 0 as a 0 — the one absence that IS a measurement', () => {
    /**
     * The third state, and the one the other two must not be confused with. A row
     * with 40 conversations and no wins has a real 0% conversion rate, and softening
     * it into "not measured" would be just as dishonest in the other direction.
     */
    renderTable(
      rosterPage({
        rows: [rosterRow({ successes: 0, success_rate_pct: 0, connected: 40, attempts: 120 })],
      }),
    );

    const row = screen.getByTestId('roster-row-user-1');
    expect(within(row).getByText('0%')).toBeTruthy();
  });
});

describe('RosterTable — the pinned cohort row', () => {
  it('spells out the median and the middle half, in plain English', () => {
    /**
     * The pinned row is where a supervisor goes to find out what the bullets above
     * it were measured against, so it says the words rather than drawing them again
     * — and it says them in the product's voice. `p25–p75` was finance notation in
     * the most prominent legend on the surface, on a screen whose reader is a floor
     * supervisor.
     */
    renderTable(rosterPage());

    expect(screen.getByTestId('roster-connect-band').textContent).toBe(
      'median 34.1% · middle half 28.4%–41.2%',
    );
    expect(screen.getByTestId('roster-conversion-band').textContent).toBe(
      'median 18% · middle half 14.2%–23.6%',
    );
    expect(screen.getByTestId('roster-team-row').textContent).not.toContain('p25');
  });

  it('gives the team row the cohort’s CONVERSIONS, beside the order it ranks by', () => {
    // `benchmark.successes` was on the payload and rendered nowhere, so the one
    // figure a dealership pays for was absent from both the row and the team line —
    // while being the roster's default sort.
    renderTable(rosterPage());
    expect(within(screen.getByTestId('roster-team-row')).getByText('149')).toBeTruthy();
  });

  it('shows the floor’s REAL pooled utilisation, with the arithmetic behind it', () => {
    /**
     * The team row used to show the cohort MEDIAN here, labelled as such, because
     * the benchmark carried the cohort's talk and wrap-up and no pooled shift. D10
     * adds `shift_seconds`, so the figure is now `(talk + wrapup) / shift` over the
     * benchmark's own totals — the floor's rate rather than a typical agent
     * standing in for it.
     *
     * The fixture's pooled rate (40%) is deliberately not its median (38.5%), so
     * this assertion cannot pass against the stand-in. The basis line is asserted
     * because this is the figure most likely to be quoted in a pay review, and
     * break is NAMED rather than subtracted — the denominator includes it.
     */
    renderTable(rosterPage());

    const team = screen.getByTestId('roster-team-row');
    expect(within(team).getByText('40%')).toBeTruthy();
    // In its units, because it is a sentence rather than a tabular cell: over a
    // 200-agent floor the stopwatch form of this line read `4800:00:00 handled of
    // 8000:00:00 on shift`.
    expect(screen.getByTestId('roster-utilisation-basis').textContent).toBe(
      '16h 46m handled of 41h 56m on shift · 2h break',
    );
    // "The whole floor" against the stand-in's "typical agent" — and the median is
    // still stated, as the different number it is.
    expect(screen.getByTestId('roster-utilisation-band').textContent).toBe(
      'the whole floor · median 38.5% · middle half 31%–46.2%',
    );
  });

  it('falls back to the median stand-in when the pooled shift has not shipped yet', () => {
    /**
     * Merge order is core → master → cusui, so this console normally deploys last
     * and the field is there. It is read through a `typeof` guard anyway: a
     * hand-mirrored type is a claim about the wire, and a reviewer already proved
     * that a `benchmark`-less page took the whole roster section down. **Every
     * absence on this surface degrades**, so a master without D10 costs this cell
     * its pooled figure and nothing else — exactly the median it showed before the
     * field existed, labelled exactly as it was.
     */
    const benchmark = rosterBenchmark();
    delete (benchmark as Partial<AgencyRosterBenchmark>).shift_seconds;
    renderTable(rosterPage({ benchmark }));

    const team = screen.getByTestId('roster-team-row');
    expect(within(team).getByText('38.5%')).toBeTruthy();
    expect(screen.getByTestId('roster-utilisation-band').textContent).toBe(
      'typical agent · middle half 31%–46.2%',
    );
    // No basis line: there is no pooled arithmetic to show, and a basis under a
    // median would describe a number that is not on screen.
    expect(screen.queryByTestId('roster-utilisation-basis')).toBeNull();
    // And the rest of the row is untouched — one missing additive field costs one
    // cell its figure, not the render.
    expect(within(team).getByText('32.5%')).toBeTruthy();
  });

  it('says the floor has no recorded shift rather than printing 0%', () => {
    /**
     * `shift_seconds: 0` is a real arrival: core's agent-state event log shipped
     * after the dialer, so a floor whose sessions predate it has no events rather
     * than zeroed ones. A zero denominator is `null`, never `0` — "0% utilised"
     * would be a confident claim that the floor sat idle.
     */
    renderTable(
      rosterPage({
        benchmark: rosterBenchmark({
          shift_seconds: 0,
          occupancy_pct: { p25: null, median: null, p75: null },
        }),
      }),
    );

    expect(screen.getByTestId('roster-utilisation-band').textContent).toBe(
      'No shift recorded for the floor',
    );
    expect(screen.getByTestId('roster-team-row').textContent).not.toContain('0%');
  });

  it('gives handle time a band too, in SECONDS', () => {
    /**
     * AHT was the one metric with a team figure and no band beside it: the
     * benchmark carried handling time only as a pooled scalar, so four minutes had
     * nothing saying whether it was ordinary on this campaign. D10 adds the
     * percentiles, and they read in the same sentence as the two rate bands — but
     * formatted as durations, because `median 74%` for a 74-second call is the one
     * mistake this field makes available.
     */
    renderTable(rosterPage());

    expect(screen.getByTestId('roster-aht-band').textContent).toBe(
      'median 1m 14s · middle half 1m 2s–1m 31s',
    );
    expect(screen.getByTestId('roster-aht-band').textContent).not.toContain('%');
    /*
      The band says its units and the CELL beside it keeps the stopwatch — the two
      formats come from one module, and this is the pair that pins which belongs
      where: `median 22:00` in prose is distinguishable from twenty-two hours only by
      counting colons, while a column of `1:14`s is scanned by shape.
    */
    expect(within(screen.getByTestId('roster-team-row')).getByText('1:14')).toBeTruthy();
  });

  it('renders no handle-time band at all when the block has not shipped yet', () => {
    /**
     * Silence rather than "no median yet — too few rated agents": that sentence is
     * a claim about the FLOOR, and making it about a field master has not deployed
     * would be a false one. The pooled figure beside it is unaffected.
     */
    const benchmark = rosterBenchmark();
    delete (benchmark as Partial<AgencyRosterBenchmark>).aht;
    renderTable(rosterPage({ benchmark }));

    expect(screen.queryByTestId('roster-aht-band')).toBeNull();
    expect(within(screen.getByTestId('roster-team-row')).getByText('1:14')).toBeTruthy();
  });

  it('shows the POOLED team rate beside the median, because they differ', () => {
    /**
     * `connect_rate_pct` on the benchmark is total connected over total attempts —
     * the floor's actual rate — and the median is what a typical agent does. They
     * diverge most exactly when one agent dialled most of the calls, which is when a
     * supervisor would otherwise quote the wrong one.
     */
    renderTable(rosterPage());

    const team = screen.getByTestId('roster-team-row');
    expect(within(team).getByText('32.5%')).toBeTruthy();
    expect(within(team).getByText(/median 34\.1%/)).toBeTruthy();
  });

  it('says how many agents cleared the dial threshold, once for the row', () => {
    /**
     * Percentiles exclude thin rows — a new joiner's 11-call rate would drag the
     * median — so the population behind the bands has to sit beside them.
     *
     * It is worded as the HEADLINE threshold and is deliberately not attached to any
     * one median: `agents_rated` is exactly the connect-rate pool's size, while the
     * success-rate pool wants `connected >= 20` on top and the utilisation pool is
     * gated on non-null seconds. Labelling it as the basis of all three would be an
     * over-claim on two of them.
     */
    renderTable(rosterPage());
    expect(screen.getByTestId('roster-rated-count').textContent).toBe(
      '6 of 8 with enough calls to rate',
    );
  });

  it('reports each percentile block’s absence on its OWN terms', () => {
    /**
     * A row can be `rates_reportable: true`, sit in the connect-rate pool and be
     * absent from the success-rate one (400 dials, 3 connects). So the blocks are
     * independent: one being all-null must not blank the others, and no block's
     * absence may name a threshold that does not gate it.
     */
    renderTable(
      rosterPage({
        benchmark: rosterBenchmark({ success_rate: { p25: null, median: null, p75: null } }),
      }),
    );

    expect(screen.getByTestId('roster-connect-band').textContent).toContain('median 34.1%');
    expect(screen.getByTestId('roster-conversion-band').textContent).toBe(
      'No median yet — too few rated agents',
    );
    // Utilisation is untouched by either — its pool has no call-count floor at all.
    expect(screen.getByTestId('roster-utilisation-band').textContent).toContain('middle half 31%');
  });

  it('renders the team row at all when every band is empty', () => {
    renderTable(
      rosterPage({
        rows: [thinRow()],
        benchmark: rosterBenchmark({
          agents_rated: 0,
          connect_rate: { p25: null, median: null, p75: null },
          success_rate: { p25: null, median: null, p75: null },
          occupancy_pct: { p25: null, median: null, p75: null },
        }),
      }),
    );

    const team = screen.getByTestId('roster-team-row');
    // The pooled floor rates are still real facts and stay on screen; only the
    // distributions are absent.
    expect(within(team).getByText('32.5%')).toBeTruthy();
    expect(screen.getByTestId('roster-connect-band').textContent).toBe(
      'No median yet — too few rated agents',
    );
    // And no threshold is implied for a pool that is not gated on one.
    expect(screen.getByTestId('roster-utilisation-band').textContent).not.toContain('20');
  });

  it('draws no bullet at all against a cohort of one', () => {
    /**
     * One rated agent IS the median, so a bullet against it tells the reader that
     * somebody is exactly average with themselves. The figures still render; the
     * table just stops claiming a cohort.
     */
    const { container } = render(
      <RosterTable
        page={rosterPage({ benchmark: rosterBenchmark({ agents_rated: 1 }) })}
        sort="successes"
        order="desc"
        onSort={vi.fn()}
        onSelect={vi.fn()}
        caption="Everyone who dialled"
      />,
    );

    expect(container.querySelectorAll('[class*="bulletValue"]').length).toBe(0);
    // The rate itself is untouched — the bullet is the comparison, not the value.
    expect(within(screen.getByTestId('roster-row-user-1')).getByText('33.8%')).toBeTruthy();
  });
});

describe('RosterTable — drilling in, and the accessibility of doing so', () => {
  it('hands the whole row to the caller when it is opened', async () => {
    const { onSelect } = renderTable(rosterPage());

    fireEvent.click(screen.getByTestId('roster-open-user-1'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      agent_user_id: 'user-1',
      agent_name: 'Ravi Kumar',
    });
  });

  it('makes the row a real button, reachable by keyboard', () => {
    /**
     * A `tabIndex` on the `<tr>` with a click handler would be focusable without
     * being a control: no role, no Enter/Space handling, and nothing in the
     * accessibility tree saying it does anything. Asserting on the ROLE is what
     * pins that — a `data-testid` would pass either way.
     */
    renderTable(rosterPage());

    const opener = screen.getByRole('button', { name: /Ravi Kumar/ });
    expect(opener.tagName).toBe('BUTTON');
    // Enter and Space come free with a real button; asserting the click path here
    // and the role above is what makes the free behaviour real.
    fireEvent.keyDown(opener, { key: 'Enter' });
  });

  it('names an unresolvable agent as a marked id rather than leaving a blank cell', () => {
    // `agent_name: null` means master could not resolve them (a deleted user, an id
    // from outside the tenant) — never "no name". A blank cell reads as a rendering
    // bug, and "Unknown" is identical for every unresolved agent.
    renderTable(rosterPage({ rows: [rosterRow({ agent_user_id: 'abcd1234-ef', agent_name: null })] }));

    expect(screen.getByRole('button', { name: /Agent abcd1234/ })).toBeTruthy();
  });

  it('names the table for a screen reader', () => {
    renderTable(rosterPage());
    expect(screen.getByRole('table', { name: 'Everyone who dialled' })).toBeTruthy();
  });
});

describe('RosterTable — sortable headers', () => {
  it('exposes every metric column as a pressable header', () => {
    /**
     * `Conv.` and `Conversion` are both gone. The table said three things for two
     * quantities — a `Conv.` column that meant connects, a "Conversion" column that
     * meant a rate, and a sort menu saying "conversations" — and on a dealership
     * campaign reading `Conv.` as bookings is roughly a 5x error on the number the
     * business runs on.
     *
     * `Conversions` (the count) is new and is the figure the default order ranks by.
     */
    renderTable(rosterPage());
    for (const label of [
      'Agent',
      'Dials',
      'Connects',
      'Connect rate',
      'Conversions',
      'Conversion rate',
      'AHT',
      'Utilisation',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /^Conv\./ })).toBeNull();
  });

  it('reports exactly one sorted header on the DEFAULT sort', () => {
    /**
     * The table's default order is `successes` desc, and there used to be no column
     * for it — so on first load every single header reported `aria-sort="none"` and
     * nothing on screen said what the rows were ranked by. The existing aria-sort
     * case below passes `sort: 'attempts'`, so the default was never exercised.
     */
    renderTable(rosterPage());

    const sorted = screen
      .getAllByRole('columnheader')
      .filter((header) => (header.getAttribute('aria-sort') ?? 'none') !== 'none');
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.textContent).toContain('Conversions');
    expect(sorted[0]!.getAttribute('aria-sort')).toBe('descending');
  });

  it('renders the conversions COUNT the default order ranks by', () => {
    renderTable(rosterPage({ rows: [rosterRow({ successes: 24 })] }));
    expect(within(screen.getByTestId('roster-row-user-1')).getByText('24')).toBeTruthy();
  });

  it('marks only the active column with aria-sort', () => {
    renderTable(rosterPage({ sort: 'attempts', order: 'asc' }));

    expect(screen.getByRole('columnheader', { name: /^Dials/ }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: /^AHT/ }).getAttribute('aria-sort')).toBe('none');
  });

  it('reports the pressed column to the caller and sorts nothing itself', () => {
    /**
     * The table is a renderer. `limit` truncates to the top N of the CHOSEN order,
     * so re-sorting the rows in hand would re-rank a page selected by a different
     * question — the reorder has to be a refetch, which is the caller's job.
     */
    const { onSort } = renderTable(
      rosterPage({
        rows: [rosterRow({ agent_user_id: 'user-1', aht_seconds: 200 }), rosterRow({ agent_user_id: 'user-2', aht_seconds: 10 })],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /^AHT/ }));

    expect(onSort).toHaveBeenCalledWith('aht_seconds');
    // Row order untouched: the table did not act on the press itself.
    const rows = screen.getAllByTestId(/^roster-row-/);
    expect(rows[0]!.getAttribute('data-testid')).toBe('roster-row-user-1');
  });

  it('leaves the Flag column unsortable', () => {
    // It is derived from a row's relationship to the benchmark, so it is not
    // something the server can order by — and a client-side sort on it would reorder
    // a page the server selected under a different question.
    renderTable(rosterPage());
    const header = screen.getByRole('columnheader', { name: 'Flag' });
    expect(within(header).queryByRole('button')).toBeNull();
  });
});

describe('RosterTable — the flag chip is never colour-only', () => {
  it('names the metric for a below-band row', () => {
    renderTable(rosterPage({ rows: [rosterRow({ success_rate_pct: 4 })] }));
    expect(screen.getByTestId('roster-flag-user-1').textContent).toBe(
      'Conversion rate below the band',
    );
  });

  it('names the metric for a top-quarter row', () => {
    renderTable(rosterPage({ rows: [rosterRow({ success_rate_pct: 40 })] }));
    expect(screen.getByTestId('roster-flag-user-1').textContent).toBe(
      'Conversion rate in the top quarter',
    );
  });

  it('does NOT reassure an agent whose connect rate is high and conversion low', () => {
    // The old rule keyed on connect rate — the metric an agent controls least — so
    // this row collected a green "Top quarter" chip.
    renderTable(rosterPage({ rows: [rosterRow({ connect_rate_pct: 66, success_rate_pct: 4 })] }));
    expect(screen.getByTestId('roster-flag-user-1').textContent).toContain('below the band');
  });

  it('leaves an unremarkable row unflagged', () => {
    // A column where every cell carries a badge is a column nobody scans, and the
    // whole value of this one is that a marked row is rare.
    renderTable(rosterPage({ rows: [rosterRow({ success_rate_pct: 18 })] }));
    expect(screen.queryByTestId('roster-flag-user-1')).toBeNull();
  });

  it('keeps the numeric rate beside the bullet, always', () => {
    // The bullet is a comparison; the value is the measurement. Nothing on this
    // table is conveyed by length or by colour alone.
    renderTable(rosterPage({ rows: [rosterRow({ connect_rate_pct: 33.8 })] }));
    expect(within(screen.getByTestId('roster-row-user-1')).getByText('33.8%')).toBeTruthy();
  });
});

describe('RosterTable — the row subline', () => {
  it('names the campaigns worked and the last dial', () => {
    renderTable(rosterPage({ rows: [rosterRow({ campaigns: 2, last_dialed_at: '2026-08-19T11:04:00.000Z' })] }));
    expect(screen.getByText('2 campaigns · last dialled 19 Aug')).toBeTruthy();
  });

  it('drops the last dial rather than claiming a state that cannot happen', () => {
    // `last_dialed_at` is `MAX(a.dialed_at)` over a group that exists because a dial
    // fell in it, so it is never null on a served row. The bespoke sentence that
    // used to be asserted here was unreachable copy.
    renderTable(rosterPage({ rows: [rosterRow({ campaigns: 2, last_dialed_at: null })] }));
    expect(screen.getByText('2 campaigns')).toBeTruthy();
    expect(document.body.textContent).not.toContain('No dials in this window');
  });
});

describe('RosterTable — the comparison it refuses to make across campaigns', () => {
  /**
   * The roster used to default to `campaign_id: null`, which pools every campaign in
   * the account into one cohort. A telecaller agency runs several dealerships at
   * once, each with its own lead list, so the median, the middle-half band and the
   * per-row chips were all computed across lists with different intrinsic
   * connectability — and the chip printed a finding beside a named person on the
   * strength of it.
   */
  it('renders no band chip at all on the pooled read', () => {
    renderTable(
      rosterPage({
        campaign_id: null,
        rows: [rosterRow({ success_rate_pct: 4 }), rosterRow({ agent_user_id: 'user-2', success_rate_pct: 40 })],
      }),
    );

    expect(screen.queryByTestId('roster-flag-user-1')).toBeNull();
    expect(screen.queryByTestId('roster-flag-user-2')).toBeNull();
  });

  it('keeps the THIN chip on the pooled read, because volume is not a comparison', () => {
    renderTable(rosterPage({ campaign_id: null, rows: [thinRow()] }));
    expect(screen.getByTestId('roster-flag-user-thin').textContent).toBe('Too few to rate');
  });

  it('draws no bullet on the pooled read, and keeps every figure', () => {
    // A bar against a band that mixes lead lists is the same claim as the chip, in a
    // form nobody can quote but everybody can compare.
    const { container } = render(
      <RosterTable
        page={rosterPage({ campaign_id: null })}
        sort="successes"
        order="desc"
        onSort={vi.fn()}
        onSelect={vi.fn()}
        caption="Everyone who dialled"
      />,
    );

    expect(container.querySelectorAll('[class*="bulletValue"]').length).toBe(0);
    expect(within(screen.getByTestId('roster-row-user-1')).getByText('33.8%')).toBeTruthy();
  });

  it('draws the bullet again once one campaign is chosen', () => {
    const { container } = render(
      <RosterTable
        page={rosterPage({ campaign_id: 'camp-1' })}
        sort="successes"
        order="desc"
        onSort={vi.fn()}
        onSelect={vi.fn()}
        caption="Everyone who dialled"
      />,
    );
    expect(container.querySelectorAll('[class*="bulletValue"]').length).toBe(1);
  });
});

describe('RosterTable — utilisation shows what it was divided by', () => {
  it('puts the handled time and the shift beneath the percentage', () => {
    /**
     * `shift_seconds` and `break_seconds` were on every row for a stated reason —
     * "so the other occupancy reading stays derivable" — and were rendered nowhere.
     * This is the figure most likely to be quoted in a pay review, and `37.5%` over
     * six hours is not the same finding as `37.5%` over forty minutes.
     */
    renderTable(rosterPage());

    const row = screen.getByTestId('roster-row-user-1');
    expect(within(row).getByText('37.5%')).toBeTruthy();
    // The percentage is the cell, the arithmetic beneath it is a sentence — so the
    // sentence names its units. `37.5%` over `6h` is not the same finding as `37.5%`
    // over `40m`, and neither is legible as `6:00:00`.
    expect(within(row).getByText('2h 15m handled of 6h on shift · 30m break')).toBeTruthy();
  });

  it('puts the definition on the column header rather than in a tooltip', () => {
    // A denominator a reader has to hover for is one most of them never see.
    renderTable(rosterPage());
    expect(
      screen.getByRole('columnheader', { name: /^Utilisation/ }).textContent,
    ).toContain('handled ÷ time on shift');
  });
});

describe('RosterTable — the needs-attention filter', () => {
  /**
   * `limit` is the roster's real constraint: the console asks for the contract's
   * maximum and phase 01 has no paging, so on a larger floor the ranking decides who
   * is visible — and under `conversions desc` the rows cut are the lowest
   * converters, the people being triaged. The flag column cannot be sorted, so
   * filtering is what makes a marked row reachable.
   */
  it('lists only the flagged rows when it is on', () => {
    renderTable(
      rosterPage({
        rows: [
          rosterRow({ agent_user_id: 'fine', success_rate_pct: 18 }),
          rosterRow({ agent_user_id: 'poor', success_rate_pct: 4 }),
        ],
      }),
      undefined,
      undefined,
      true,
    );

    expect(screen.queryByTestId('roster-row-fine')).toBeNull();
    expect(screen.getByTestId('roster-row-poor')).toBeTruthy();
  });

  it('leaves the cohort row, the axis and the counts measured over the WHOLE page', () => {
    // It changes which rows are listed and nothing else: the pinned row is a fact
    // about the cohort, not about the filter.
    const page = rosterPage({
      rows: [
        rosterRow({ agent_user_id: 'fine', success_rate_pct: 18 }),
        rosterRow({ agent_user_id: 'poor', success_rate_pct: 4 }),
      ],
    });
    renderTable(page, undefined, undefined, false);
    const before = screen.getByTestId('roster-team-row').textContent;
    cleanup();

    renderTable(page, undefined, undefined, true);
    expect(screen.getByTestId('roster-team-row').textContent).toBe(before);
  });
});
