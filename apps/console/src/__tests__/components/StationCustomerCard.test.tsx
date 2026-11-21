import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { CustomerCardView } from '../../components/agency/station/StationCustomer';
import { ScriptOpeningCard, ScriptStepsCard } from '../../components/agency/station/StationScript';
import { customerCard } from '../../utils/agency/stationCustomer';
import { fillScriptLine, scriptFillFor } from '../../utils/agency/stationScript';
import type { AgencyContextDisplay, AgencyReservedAttempt } from '../../types/agency';

/**
 * AS19 on the station's card, rendered: the chosen tiles (name, value, highlight first and two
 * wide, "—"), the hover card on focus and pointer with "From column: X", Escape closing it, a
 * masked phone masked in the tile and the card, today's card exactly as it was, and the script's
 * "not given" in the muted style, which Read aloud skips.
 */

afterEach(cleanup);

const NOW = new Date('2026-11-21T10:00:00Z');

const BASE: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 2,
  context: { Name: 'Ramesh Goud', City: 'Siddipet', 'Amount due': '12500', 'Due date': '2026-11-20' },
  prior_attempts: [
    { attempt_number: 1, outcome: 'connected', disposition_code: 'later', notes: 'Asked to call after salary.', ended_at: '2026-11-12T10:00:00Z', dialed_at: null, campaign_id: 'camp-1', campaign_name: 'EMI collections' },
  ],
};

const DISPLAY: AgencyContextDisplay = {
  facts: [
    { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true },
    { column: 'Alt phone', label: 'Other number', key: 'alt_phone' },
    { column: 'EMI date', label: 'Due date', key: 'due_date' },
  ],
};

const CHOSEN: AgencyReservedAttempt = {
  ...BASE,
  facts: {
    name: 'Sunita Patil',
    place: 'Shivajinagar, near the old bus stand, Pune',
    tiles: [
      { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '1,25,000', value: '125000' },
      { column: 'Alt phone', label: 'Other number', key: 'alt_phone', type: 'phone', raw: '98765 12345', value: '9876512345' },
      { column: 'EMI date', label: 'Due date', key: 'due_date', role: 'due_date', type: 'date', raw: '', value: null },
    ],
  },
};

function renderChosen(phoneDisplay: 'full' | 'masked' = 'masked') {
  render(<CustomerCardView card={customerCard(CHOSEN, DISPLAY, { phoneDisplay, now: NOW })} />);
  return screen.getAllByTestId('customer-fact');
}

describe('the chosen facts card (AS19)', () => {
  it('names each tile by its label, highlight first and two wide, an empty value as —', () => {
    const tiles = renderChosen();
    expect(tiles.map((t) => [
      within(t).getByTestId('customer-fact-label').textContent,
      within(t).getByTestId('customer-fact-value').textContent,
      t.getAttribute('data-highlight'),
      t.getAttribute('data-span'),
    ])).toEqual([
      ['Amount due', '₹1,25,000', 'true', '6'],
      ['Other number', '98••• ••345', null, '3'],
      ['Due date', '—', null, '3'],
    ]);
    expect(within(tiles[2]!).getByTestId('customer-fact-value').getAttribute('data-empty')).toBe('true');
    // Every tile is reachable with the keyboard; no "Last call" tile.
    expect(tiles.every((t) => t.tabIndex === 0)).toBe(true);
    expect(screen.queryByText('Last call')).toBeNull();
    // The number always sits under the name; the place line is one line, its whole text on hover.
    expect(screen.getByTestId('customer-phone').textContent).toBe('98••• ••321');
    expect(screen.getByTestId('customer-place').getAttribute('title')).toBe('Shivajinagar, near the old bus stand, Pune');
  });

  it('opens the hover card on keyboard focus with the name, the value and its column; Escape closes it', () => {
    const tiles = renderChosen();
    expect(screen.queryByTestId('fact-hover-card')).toBeNull();
    fireEvent.focus(tiles[0]!);
    const card = screen.getByRole('tooltip');
    expect(tiles[0]!.getAttribute('aria-describedby')).toBe(card.id);
    expect(card.textContent).toBe('Amount due₹1,25,000From column: Outstanding');
    // Escape closes it, and nothing else on the screen hears that Escape.
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(tiles[0]!, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(tiles[0]!.getAttribute('aria-describedby')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // Focus leaving and coming back opens it again.
    fireEvent.blur(tiles[0]!);
    fireEvent.focus(tiles[0]!);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.blur(tiles[0]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on a pointer hover, one at a time, and a masked phone never shows its digits there', () => {
    const tiles = renderChosen('masked');
    fireEvent.pointerEnter(tiles[0]!);
    fireEvent.pointerEnter(tiles[1]!);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toBe('Other number98••• ••345From column: Alt phone');
    expect(card.textContent).not.toContain('98765');
    expect(card.textContent).not.toContain('12345');
    fireEvent.pointerLeave(tiles[1]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the whole phone when the campaign shows numbers in full', () => {
    const tiles = renderChosen('full');
    fireEvent.focus(tiles[1]!);
    expect(screen.getByRole('tooltip').textContent).toBe('Other number+91 98765 12345From column: Alt phone');
  });

  it('calls a nameless customer "Customer" and keeps the number under it', () => {
    render(<CustomerCardView card={customerCard({ ...CHOSEN, facts: { tiles: CHOSEN.facts!.tiles } }, DISPLAY)} />);
    expect(screen.getByTestId('customer-name').textContent).toBe('Customer');
    expect(screen.getByTestId('customer-phone').textContent).toBe('+91 98765 43321');
  });
});

describe('today’s card, without chosen facts, is unchanged', () => {
  it('three across with Last call, no focusable tiles and no hover card', () => {
    render(<CustomerCardView card={customerCard(BASE, { hero: ['Name', 'City', 'Amount due', 'Due date'] })} />);
    const tiles = screen.getAllByTestId('customer-fact');
    expect(tiles.map((t) => t.textContent)).toEqual(['Amount due12500', 'Due date20 Nov', 'Last call12 Nov']);
    expect(tiles.every((t) => !t.hasAttribute('tabindex'))).toBe(true);
    fireEvent.focus(tiles[0]!);
    fireEvent.pointerEnter(tiles[0]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByTestId('customer-facts')).toBeNull();
    expect(screen.getByTestId('customer-last-said').textContent).toBe('What they said last time“Asked to call after salary.”');
    // No name: the number is the title, and is not repeated under it.
    cleanup();
    render(<CustomerCardView card={customerCard({ ...BASE, context: { Loan: 'L-1' } }, {})} />);
    expect(screen.getByTestId('customer-name').textContent).toBe('+91 98765 43321');
    expect(screen.queryByTestId('customer-phone')).toBeNull();
  });
});

describe('the script with chosen facts (AS19)', () => {
  const fill = () =>
    scriptFillFor(CHOSEN, { name: 'Sunita Patil', place: null }, { agentName: 'Ravi Kumar', campaignName: 'EMI collections' }, DISPLAY, { now: NOW });

  it('shows an empty key as "<label> not given" in the muted style, and Read aloud skips it', () => {
    const say = vi.fn();
    const line = fillScriptLine('Namaste {name}, {amount_due} was due on {due_date}.', fill());
    render(<ScriptOpeningCard line={line} readAloud={{ available: true, say }} />);
    expect(screen.getByTestId('script-opening-line').textContent).toBe('“Namaste Sunita Patil, ₹1,25,000 was due on Due date not given.”');
    expect(screen.getByTestId('script-missing').textContent).toBe('Due date not given');
    fireEvent.click(screen.getByTestId('script-opening-say'));
    expect(say).toHaveBeenCalledWith('Namaste Sunita Patil, ₹1,25,000 was due on.');
  });

  it('marks the "not given" runs in the steps too', () => {
    render(<ScriptStepsCard steps={[fillScriptLine('Ask about {place}.', fill()), fillScriptLine('Ask when.', fill())]} />);
    const steps = screen.getAllByTestId('script-step');
    expect(steps.map((s) => s.textContent)).toEqual(['1Ask about Place not given.', '2Ask when.']);
    expect(within(steps[0]!).getByTestId('script-missing').textContent).toBe('Place not given');
  });
});
