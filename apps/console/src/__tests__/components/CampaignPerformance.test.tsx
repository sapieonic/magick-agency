import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CampaignPerformance } from '../../components/agency/CampaignPerformance';
import type { AgencyCampaignStats } from '../../types/agency-campaign';

/**
 * The derived figures, as rendered.
 *
 * The derivations themselves are pinned in `utils/agencyCampaignPerformance.test.ts`.
 * What is asserted here is what only the component decides: that a structurally
 * unmeasurable bucket paints an em dash rather than its `0`, that a caveat is on
 * the page rather than in a `title` attribute nobody hovers, and that the whole
 * breakdown disappears rather than rendering a partial sum.
 */

afterEach(cleanup);

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    stall: null,
    other_stalls: [],
    concurrency_limit: 10,
    concurrency_in_use: 3,
    abandonment_ceiling_pct: 5,
    connect_rate_pct: 66,
    human_connects: 40,
    machine_connects: 12,
    unclassified_connects: 0,
    machine_connects_available: true,
    aht_seconds: 134,
    aht_seconds_including_machine: 151,
    avg_wrapup_seconds: 18,
    ...over,
  };
}

describe('CampaignPerformance', () => {
  it('renders the three derived figures a supervisor reads', () => {
    render(<CampaignPerformance stats={stats()} wrapupSeconds={45} />);

    expect(within(screen.getByTestId('connect-rate-readout')).getByText('66%')).toBeTruthy();
    expect(within(screen.getByTestId('handle-time-readout')).getByText('2:14')).toBeTruthy();
    expect(within(screen.getByTestId('wrapup-readout')).getByText('0:18')).toBeTruthy();
  });

  it('renders the conversion rate and its success count', () => {
    /**
     * Follow-up: `is_success` had been settable on every campaign's
     * disposition catalog and read by nothing, so a "Counts as a success" tick
     * had no output anywhere in the product. This readout is its first consumer.
     */
    render(
      <CampaignPerformance
        stats={stats({ success_rate_pct: 22.5, attempts_success: 9, attempts_connected: 41 })}
        wrapupSeconds={45}
      />,
    );

    const readout = screen.getByTestId('conversion-rate-readout');
    expect(within(readout).getByText('22.5%')).toBeTruthy();
    // The count is this rate's numerator, so it is on the denominator line
    // rather than floating beside the figure as a second headline.
    expect(screen.getByTestId('conversion-rate-readout-secondary').textContent)
      .toBe('9 of 41 connected calls');
  });

  it('agrees its counts with one connected call (QA analytics:bug:c60501878e)', () => {
    // "Where the 1 connected calls went" and "1 of 1 connected calls" were what one call read as.
    render(
      <CampaignPerformance
        stats={stats({ human_connects: 1, machine_connects: 0, attempts_success: 1, attempts_connected: 1 })}
        wrapupSeconds={45}
      />,
    );
    expect(within(screen.getByTestId('connects-breakdown')).getByRole('heading').textContent)
      .toBe('Where the 1 connected call went');
    expect(screen.getByTestId('conversion-rate-readout-secondary').textContent).toBe('1 of 1 connected call');
  });

  it('keeps the plural for any other count', () => {
    render(<CampaignPerformance stats={stats()} wrapupSeconds={45} />);
    expect(within(screen.getByTestId('connects-breakdown')).getByRole('heading').textContent)
      .toBe('Where the 52 connected calls went');
  });

  it('labels the conversion rate with its denominator, on the page', () => {
    // Two percentages side by side with different denominators is the one way
    // this row can mislead. The label says which, at full weight, not in a title.
    render(<CampaignPerformance stats={stats({ success_rate_pct: 22.5 })} />);

    const readout = screen.getByTestId('conversion-rate-readout');
    expect(within(readout).getByText(/Conversion of conversations/)).toBeTruthy();
    expect(readout.textContent).toContain('not out of every dial');
  });

  it('never renders a null conversion rate as 0%', () => {
    /**
     * The rule this whole surface is built on, asserted at the DOM rather than
     * only on the readout: `null` is "nothing has connected yet", and `0.0%`
     * there is a verdict on agents who have not had a conversation to convert.
     */
    render(<CampaignPerformance stats={stats({ success_rate_pct: null })} />);

    const readout = screen.getByTestId('conversion-rate-readout');
    expect(readout.getAttribute('data-known')).toBe('false');
    expect(readout.textContent).not.toContain('0%');
    expect(readout.textContent).not.toContain('0.0%');
    expect(within(readout).getByText('No data')).toBeTruthy();
  });

  it('shows the with-voicemail average beside handle time', () => {
    // the outcome split, as the second bar of the comparison rather than a sentence:
    // the delta between the two averages is what the split is for.
    render(<CampaignPerformance stats={stats()} wrapupSeconds={45} />);
    const readout = screen.getByTestId('handle-time-readout');
    expect(within(readout).getByText('2:14 excl. vm')).toBeTruthy();
    expect(within(readout).getByText('2:31 incl. vm')).toBeTruthy();
  });

  it('names what handle time excluded, on its denominator line', () => {
    render(<CampaignPerformance stats={stats()} wrapupSeconds={45} />);
    expect(screen.getByTestId('handle-time-readout-secondary').textContent)
      .toBe('Voicemail excluded — the dialler’s own figure');
  });

  it('marks a figure unknown rather than colouring it as a problem', () => {
    render(<CampaignPerformance stats={stats({ connect_rate_pct: undefined })} />);
    const readout = screen.getByTestId('connect-rate-readout');
    expect(readout.getAttribute('data-known')).toBe('false');
    expect(within(readout).getByText('—')).toBeTruthy();
  });

  it('distinguishes "didn’t load" from "nothing to measure"', () => {
    const { rerender } = render(<CampaignPerformance stats={stats({ aht_seconds: undefined })} />);
    expect(within(screen.getByTestId('handle-time-readout')).getByText('—')).toBeTruthy();

    rerender(<CampaignPerformance stats={stats({ aht_seconds: null })} />);
    expect(within(screen.getByTestId('handle-time-readout')).getByText('No data')).toBeTruthy();
  });

  it('puts the caveat on the page, not in a tooltip', () => {
    render(
      <CampaignPerformance
        // A campaign that never offered the code: nothing labelled, and both
        // AHT figures therefore identical. The base fixture's 12 machine
        // connects would make this the withdrawn-code case instead.
        stats={stats({
          machine_connects: 0,
          machine_connects_available: false,
          aht_seconds_including_machine: 134,
        })}
        wrapupSeconds={45}
      />,
    );
    // Visible text, not a `title` — a caveat that must be hovered to be found is
    // a caveat the number gets quoted without.
    const caveat = screen.getByTestId('handle-time-readout-caveat');
    expect(caveat.textContent).toMatch(/answering machines are inside this average/);
  });

  it('renders the machine bucket as an em dash when it cannot be measured', () => {
    render(
      <CampaignPerformance
        stats={stats({ machine_connects: 0, machine_connects_available: false })}
      />,
    );
    const machine = screen.getByTestId('connects-machine');
    expect(machine.getAttribute('data-unmeasured')).toBe('true');
    expect(screen.getByTestId('connects-machine-count').textContent).toBe('—');
    // Its share goes with its count: a percentage of a number we are refusing to
    // print is the same claim wearing a decimal point.
    expect(screen.getByTestId('connects-machine-share').textContent).toBe('—');
    // The failure this prevents: reporting "0 answering machines" about a
    // campaign that offers agents no way to record one.
    expect(within(machine).queryByText('0')).toBeNull();
  });

  it('renders a real zero as zero', () => {
    render(<CampaignPerformance stats={stats({ machine_connects: 0 })} />);
    const machine = screen.getByTestId('connects-machine');
    expect(machine.getAttribute('data-unmeasured')).toBe('false');
    expect(screen.getByTestId('connects-machine-count').textContent).toBe('0');
    expect(screen.getByTestId('connects-machine-share').textContent).toBe('0%');
  });

  it('hides the whole breakdown rather than rendering a partial sum', () => {
    render(<CampaignPerformance stats={stats({ unclassified_connects: undefined })} />);
    expect(screen.queryByTestId('connects-breakdown')).toBeNull();
    // The readouts above it are unaffected — they read different fields.
    expect(screen.getByTestId('connect-rate-readout')).toBeTruthy();
  });

  it('survives the first render, before any payload has arrived', () => {
    render(<CampaignPerformance stats={null} />);
    expect(screen.getByTestId('connect-rate-readout').getAttribute('data-known')).toBe('false');
    expect(screen.queryByTestId('connects-breakdown')).toBeNull();
    expect(screen.queryByTestId('handled-call-cost')).toBeNull();
  });

  it('withholds both rates on a campaign that has barely dialled', () => {
    /**
     * The threshold reaching the DOM. A percentage is the figure that leaves the
     * room, and over a handful of dials it moves several points per answered
     * call — so it lands in the same dimmed, `data-known="false"` state a failed
     * read does, and for a reason the card states in words.
     */
    render(
      <CampaignPerformance
        stats={stats({ attempts_total: 24, attempts_connected: 8, success_rate_pct: 25 })}
        wrapupSeconds={45}
      />,
    );

    for (const id of ['connect-rate-readout', 'conversion-rate-readout']) {
      const readout = screen.getByTestId(id);
      expect(readout.getAttribute('data-known')).toBe('false');
      expect(within(readout).getByText('Not enough dials')).toBeTruthy();
      expect(readout.textContent).toContain('25 dials placed');
      expect(readout.textContent).not.toContain('%');
    }

    // Averages over completed calls are not proportions and are unaffected.
    expect(screen.getByTestId('handle-time-readout').getAttribute('data-known')).toBe('true');
    expect(screen.getByTestId('wrapup-readout').getAttribute('data-known')).toBe('true');
  });

  it('publishes the rates once the campaign has dialled enough', () => {
    render(
      <CampaignPerformance
        stats={stats({ attempts_total: 25, attempts_connected: 8, success_rate_pct: 25 })}
      />,
    );
    expect(screen.getByTestId('connect-rate-readout').getAttribute('data-known')).toBe('true');
    expect(within(screen.getByTestId('conversion-rate-readout')).getByText('25%')).toBeTruthy();
  });

  it('costs one handled call out of the two averages, and calls it a ceiling', () => {
    render(
      <CampaignPerformance
        stats={stats({
          aht_seconds: 194,
          avg_wrapup_seconds: 38,
          attempts_total: 400,
          success_rate_pct: 20.5,
        })}
        wrapupSeconds={45}
      />,
    );

    const card = screen.getByTestId('handled-call-cost');
    expect(within(card).getByText('3:52')).toBeTruthy();
    expect(screen.getByTestId('cost-per-hour').textContent).toBe('15.5');
    expect(screen.getByTestId('cost-wins-per-hour').textContent).toBe('3.2');
    // The rate the wins figure was taken at, beside it rather than assumed.
    expect(card.textContent).toContain('20.5% conversion');
    expect(card.textContent).toContain('A ceiling, not a forecast');
  });

  it('drops wins per hour with the conversion rate it is made of', () => {
    // A rate this console refuses to publish must not reappear multiplied into a
    // figure with the word "wins" on it, which is more quotable than the rate.
    render(
      <CampaignPerformance
        stats={stats({
          aht_seconds: 194,
          avg_wrapup_seconds: 38,
          attempts_total: 9,
          success_rate_pct: 20.5,
        })}
      />,
    );
    expect(screen.getByTestId('cost-per-hour').textContent).toBe('15.5');
    expect(screen.queryByTestId('cost-wins-per-hour')).toBeNull();
  });

  it('hides the cost card rather than costing a call out of one average', () => {
    // Substituting a zero for the missing half would not degrade the estimate,
    // it would inflate it — and the inflated number is the one that gets used
    // as a target.
    render(<CampaignPerformance stats={stats({ avg_wrapup_seconds: null })} />);
    expect(screen.queryByTestId('handled-call-cost')).toBeNull();
    // The figures that can still be read are unaffected.
    expect(screen.getByTestId('handle-time-readout').getAttribute('data-known')).toBe('true');
  });

  it('does not mount the by-day trend, and fetches nothing of its own', () => {
    /**
     * A trend belongs to the one-campaign Insights tab, not to this component:
     * `AgencyAnalyticsPage` renders this component once per campaign inside a
     * list, and a fetch in here would be one request per row of a page that
     * never asked the question.
     *
     * Asserted at the DOM rather than by a spy, and this file mocks NOTHING as
     * a result: a component that fetches nothing needs no network stub, and the
     * day a stub becomes necessary here is the day this property was lost.
     */
    const { container } = render(<CampaignPerformance stats={stats()} wrapupSeconds={45} />);
    expect(screen.queryByTestId('campaign-series-rates')).toBeNull();
    expect(container.textContent).not.toContain('Are the rates holding');
  });
});

describe('the soft phone beside the dialler (SR1, SR5)', () => {
  const dialled = { first_dials_placed: 200, human_connects: 40, attempts_connected: 52, connect_rate_pct: 20 };

  it('names the dialler\'s rate as the dialler\'s and adds the soft phone\'s and the Outbound rate', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 50, connected: 40, human_connects: 30, talk_seconds: 4800 } })} softphoneEnabled />);
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('Dialler connect rate')).toBeTruthy();
    // The dialler's own figure, untouched by the soft phone's 60%.
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('20%')).toBeTruthy();
    const soft = screen.getByTestId('softphone-rate-readout');
    expect(within(soft).getByText('60%')).toBeTruthy();
    expect(soft.textContent).toContain('of 50 soft-phone calls placed · 40 connected');
    const all = screen.getByTestId('outbound-rate-readout');
    // The dialler and the soft phone together, called Outbound (CL7): (40 + 30) / (200 + 50) = 28%.
    expect(within(all).getByText('Outbound connect rate')).toBeTruthy();
    expect(screen.queryByText('All calls connect rate')).toBeNull();
    expect(within(all).getByText('28%')).toBeTruthy();
    expect(all.textContent).toContain('of 250 calls placed · 92 connected');
  });

  it('withholds the soft phone\'s rate below the floor', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 4, connected: 3, human_connects: 2, talk_seconds: 360 } })} softphoneEnabled />);
    // In calls, not dials: a soft-phone call is not a dial of the dialler's.
    const soft = screen.getByTestId('softphone-rate-readout');
    expect(within(soft).getByText('Not enough calls')).toBeTruthy();
    expect(soft.textContent).toContain('4 soft-phone calls placed so far');
    expect(soft.textContent).not.toContain('dial');
  });

  it('withholds the Outbound rate below the floor on its own denominator, in calls', () => {
    render(<CampaignPerformance stats={stats({ first_dials_placed: 10, attempts_total: 10, human_connects: 2, attempts_connected: 3, connect_rate_pct: 20, softphone: { placed: 1, connected: 1, human_connects: 1, talk_seconds: 120 } })} softphoneEnabled />);
    const all = screen.getByTestId('outbound-rate-readout');
    expect(within(all).getByText('Not enough calls')).toBeTruthy();
    expect(all.textContent).toContain('11 calls placed so far');
    // The dialler's own rate keeps its words.
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('Not enough dials')).toBeTruthy();
  });

  it('shows nothing of the soft phone while it is off and the campaign holds none', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 0, connected: 0, human_connects: 0, talk_seconds: 0 } })} />);
    expect(screen.queryByTestId('softphone-rate-readout')).toBeNull();
    expect(screen.queryByTestId('outbound-rate-readout')).toBeNull();
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('Connect rate')).toBeTruthy();
  });

  it('shows calls already logged even with the soft phone off since', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 30, connected: 20, human_connects: 10, talk_seconds: 2400 } })} />);
    expect(screen.getByTestId('softphone-rate-readout')).toBeTruthy();
  });
});

describe('inbound calls beside both (call log P4, CL7)', () => {
  const dialled = { first_dials_placed: 200, human_connects: 40, attempts_connected: 52, connect_rate_pct: 20 };
  const softphone = { placed: 50, connected: 40, human_connects: 30, talk_seconds: 4800 };
  const inbound = { received: 57, answered: 44, missed: 13, open_follow_ups: 6, talk_seconds: 10_500, open_hours: 53 };

  it('shows the answer rate over the calls that arrived in open hours, and moves no connect rate', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone, inbound })} softphoneEnabled inboundEnabled />);
    const card = screen.getByTestId('inbound-rate-readout');
    expect(within(card).getByText('Answer rate, open hours')).toBeTruthy();
    // 44 of 53, not of the 57 received.
    expect(within(card).getByText('83%')).toBeTruthy();
    expect(card.textContent).toContain('answered, of 53 calls in open hours · 57 calls received · 13 missed · 6 to follow up');
    // The dialler's rate and the Outbound rate are what they are without an inbound call.
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('20%')).toBeTruthy();
    expect(within(screen.getByTestId('outbound-rate-readout')).getByText('28%')).toBeTruthy();
  });

  it('withholds the answer rate below the floor on its own denominator', () => {
    render(<CampaignPerformance stats={stats({ ...dialled, softphone, inbound: { ...inbound, received: 10, answered: 8, missed: 2, open_hours: 10 } })} inboundEnabled />);
    const card = screen.getByTestId('inbound-rate-readout');
    expect(within(card).getByText('Not enough calls')).toBeTruthy();
    expect(card.textContent).toContain('10 calls received');
  });

  it('shows nothing of inbound while it is off and the campaign holds none, and calls already filed when it is off since', () => {
    const none = { received: 0, answered: 0, missed: 0, open_follow_ups: 0, talk_seconds: 0, open_hours: 0 };
    const { unmount } = render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 0, connected: 0, human_connects: 0, talk_seconds: 0 }, inbound: none })} />);
    expect(screen.queryByTestId('inbound-rate-readout')).toBeNull();
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('Connect rate')).toBeTruthy();
    unmount();
    render(<CampaignPerformance stats={stats({ ...dialled, softphone: { placed: 0, connected: 0, human_connects: 0, talk_seconds: 0 }, inbound })} />);
    expect(screen.getByTestId('inbound-rate-readout')).toBeTruthy();
    // The dialler's rate is named as the dialler's once another type's figure sits beside it.
    expect(within(screen.getByTestId('connect-rate-readout')).getByText('Dialler connect rate')).toBeTruthy();
    expect(screen.queryByTestId('outbound-rate-readout')).toBeNull();
  });
});
