import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { parsePhoneFact } from '@magick-agency/domain/context-facts';
import { CustomerCardView } from '../../components/agency/station/StationCustomer';
import { ScriptOpeningCard, ScriptStepsCard } from '../../components/agency/station/StationScript';
import { customerCard, factPopPlacement } from '../../utils/agency/stationCustomer';
import { fillScriptLine, scriptFillFor } from '../../utils/agency/stationScript';
import type { AgencyContextDisplay, AgencyReservedAttempt } from '../../types/agency';
import { PHONE_RULE_TABLE } from '../helpers/phoneRule';

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

  it('tells a screen reader an empty fact is not given (S11)', () => {
    const tiles = renderChosen();
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(['Amount due: ₹1,25,000', 'Other number: 98••• ••345', 'Due date: not given']);
  });
});

describe('the compact card on What happened? and the side views (S4)', () => {
  const nameless = { ...CHOSEN, facts: { tiles: CHOSEN.facts!.tiles } };

  it('a nameless customer is "Customer", the line under it the number (masked as set) then the first fact', () => {
    render(<CustomerCardView card={customerCard(nameless, DISPLAY, { phoneDisplay: 'masked', now: NOW })} compact />);
    expect(screen.getByTestId('customer-name').textContent).toBe('Customer');
    expect(screen.getByTestId('customer-line').textContent).toBe('98••• ••321Amount due: ₹1,25,000');
    expect(screen.getByTestId('customer-phone').textContent).toBe('98••• ••321');
    cleanup();
    render(<CustomerCardView card={customerCard(nameless, DISPLAY, { phoneDisplay: 'full', now: NOW })} compact />);
    expect(screen.getByTestId('customer-line').textContent).toBe('+91 98765 43321Amount due: ₹1,25,000');
  });

  it('with a name, the line is the first fact; with no fact, the number', () => {
    render(<CustomerCardView card={customerCard(CHOSEN, DISPLAY, { phoneDisplay: 'masked', now: NOW })} compact />);
    expect(screen.getByTestId('customer-name').textContent).toBe('Sunita Patil');
    expect(screen.getByTestId('customer-line').textContent).toBe('Amount due: ₹1,25,000');
    cleanup();
    render(<CustomerCardView card={customerCard({ ...nameless, facts: { tiles: [] } }, { facts: [] }, { phoneDisplay: 'masked' })} compact />);
    expect(screen.getByTestId('customer-name').textContent).toBe('Customer');
    expect(screen.getByTestId('customer-line').textContent).toBe('98••• ••321');
  });

  it('today’s compact card is unchanged: the number is the title when there is no name', () => {
    render(<CustomerCardView card={customerCard({ ...BASE, context: { Loan: 'L-1', 'Amount due': '12500' } }, { hero: ['Amount due'] })} compact />);
    expect(screen.getByTestId('customer-name').textContent).toBe('+91 98765 43321');
    expect(screen.getByTestId('customer-line').textContent).toBe('Amount due: 12500');
  });
});

describe('the hover card opens on hover and keyboard focus only, inside the card’s column (S11)', () => {
  it('a mouse click that focuses a tile opens no card; leaving it after the click leaves none', () => {
    const tiles = renderChosen();
    // The click: the pointer is over the tile, pressed, and the press focuses it.
    fireEvent.pointerEnter(tiles[1]!);
    fireEvent.pointerDown(tiles[1]!);
    fireEvent.focus(tiles[1]!);
    expect(screen.getByRole('tooltip').textContent).toContain('Other number');
    fireEvent.pointerLeave(tiles[1]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The keyboard reaching it again (after a blur) opens it.
    fireEvent.blur(tiles[1]!);
    fireEvent.focus(tiles[1]!);
    expect(screen.getByRole('tooltip').textContent).toContain('Other number');
  });

  it('a press on a tile that already has the focus does not swallow the next keyboard focus', () => {
    const tiles = renderChosen();
    act(() => tiles[0]!.focus());
    expect(screen.getByRole('tooltip').textContent).toContain('Amount due');
    fireEvent.pointerDown(tiles[0]!);
    act(() => tiles[0]!.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => tiles[0]!.focus());
    expect(screen.getByRole('tooltip').textContent).toContain('Amount due');
  });

  it('places the card under the tile, shifted to end inside the column, never past its start, flipped above near the bottom', () => {
    const column = { left: 100, right: 600 };
    // Room to the right: no shift.
    expect(factPopPlacement({ left: 120, top: 50, bottom: 120 }, column, { width: 250, height: 90 }, 900)).toEqual({ shift: 0, maxWidth: 300, above: false });
    // The right-hand tile: shifted left so the card ends at the column's edge.
    expect(factPopPlacement({ left: 480, top: 50, bottom: 120 }, column, { width: 250, height: 90 }, 900)).toMatchObject({ shift: -130 });
    // A column narrower than the card: as wide as the column, from its start.
    expect(factPopPlacement({ left: 160, top: 50, bottom: 120 }, { left: 150, right: 350 }, { width: 300, height: 90 }, 900)).toEqual({ shift: -10, maxWidth: 200, above: false });
    // Near the window's bottom with room above: above.
    expect(factPopPlacement({ left: 120, top: 800, bottom: 870 }, column, { width: 250, height: 90 }, 900)).toMatchObject({ above: true });
    // Not measured (no layout): left alone.
    expect(factPopPlacement({ left: 0, top: 0, bottom: 0 }, { left: 0, right: 0 }, { width: 0, height: 0 }, 900)).toBeNull();
  });

  it('shifts the right-hand tile’s card inside the facts row on screen', () => {
    const rect = (left: number, width: number, top = 0, height = 80) =>
      ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('data-testid') === 'customer-facts') return rect(100, 500);
      if (this.getAttribute('data-testid') === 'customer-fact') return rect(480, 120, 200);
      if (this.getAttribute('data-testid') === 'fact-hover-card') return rect(480, 260, 288, 90);
      return rect(0, 0);
    });
    try {
      const tiles = renderChosen();
      fireEvent.pointerEnter(tiles[2]!);
      const card = screen.getByRole('tooltip');
      expect(card.style.left).toBe('-140px');
      expect(card.style.maxWidth).toBe('300px');
      expect(card.dataset['side']).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the hover card and the fitted value (R11)', () => {
  it('Escape closes the card from anywhere, not only on the tile', () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <CustomerCardView card={customerCard(CHOSEN, DISPLAY, { phoneDisplay: 'masked', now: NOW })} />
      </>,
    );
    const tiles = screen.getAllByTestId('customer-fact');
    fireEvent.pointerEnter(tiles[0]!);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Elsewhere' }), { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A focused tile's card closes on an Escape the document hears, too; another key leaves it.
    fireEvent.focus(tiles[1]!);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    // It opens again on the next hover.
    fireEvent.pointerEnter(tiles[2]!);
    expect(screen.getByRole('tooltip').textContent).toBe('Due date—From column: EMI date');
  });

  it('pointing at B while A has the focus shows B; leaving B brings A’s card back, or none once A is blurred', () => {
    const tiles = renderChosen();
    fireEvent.focus(tiles[0]!);
    fireEvent.pointerEnter(tiles[1]!);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip').textContent).toBe('Other number98••• ••345From column: Alt phone');
    fireEvent.pointerLeave(tiles[1]!);
    expect(screen.getByRole('tooltip').textContent).toBe('Amount due₹1,25,000From column: Outstanding');
    expect(tiles[0]!.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.pointerEnter(tiles[1]!);
    fireEvent.blur(tiles[0]!);
    fireEvent.pointerLeave(tiles[1]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  /** A value at 28px in a 200px box; `size.scroll` is how wide its text is. */
  function measured() {
    const size = { client: 200, scroll: 180 };
    const realStyle = window.getComputedStyle.bind(window);
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el.getAttribute('data-testid') === 'customer-fact-value' ? ({ fontSize: '28px' } as CSSStyleDeclaration) : realStyle(el, pseudo),
    );
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => size.client });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => size.scroll });
    const restore = () => {
      style.mockRestore();
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      delete (document as { fonts?: unknown }).fonts;
    };
    return { size, restore };
  }

  it('measures the value again when the fonts finish loading', async () => {
    const { size, restore } = measured();
    let loaded!: () => void;
    const ready = new Promise<void>((done) => {
      loaded = done;
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    try {
      const tiles = renderChosen();
      const value = within(tiles[0]!).getByTestId('customer-fact-value');
      expect(value.style.fontSize).toBe('');
      // The page's font is wider than the fallback the first measure saw.
      size.scroll = 250;
      await act(async () => {
        loaded();
        await ready;
      });
      expect(value.style.fontSize).toBe('21.5px');
    } finally {
      restore();
    }
  });

  it('measures the value again each time more fonts finish loading (`loadingdone`, S11)', async () => {
    const { size, restore } = measured();
    const fonts = new EventTarget() as EventTarget & { ready: Promise<void> };
    fonts.ready = Promise.resolve();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      const tiles = renderChosen();
      const value = within(tiles[0]!).getByTestId('customer-fact-value');
      await act(async () => {
        await fonts.ready;
      });
      expect(value.style.fontSize).toBe('');
      // A font face that loads later (after `ready`) makes the value wider.
      size.scroll = 250;
      act(() => {
        fonts.dispatchEvent(new Event('loadingdone'));
      });
      expect(value.style.fontSize).toBe('21.5px');
    } finally {
      restore();
    }
  });

  it('measures the value again when the tile is highlighted', () => {
    const { size, restore } = measured();
    try {
      const base = customerCard(CHOSEN, DISPLAY, { now: NOW });
      const one = (highlight: boolean) => ({ ...base, facts: [{ ...base.facts[0]!, highlight, span: 12 }] });
      const { rerender } = render(<CustomerCardView card={one(false)} />);
      const value = screen.getByTestId('customer-fact-value');
      expect(value.style.fontSize).toBe('');
      // The highlight's value is set larger: the same text no longer fits the same width.
      size.scroll = 250;
      rerender(<CustomerCardView card={one(true)} />);
      expect(value.style.fontSize).toBe('21.5px');
    } finally {
      restore();
    }
  });
});

describe('one phone rule on the tile, the hover card and the aria text (R6)', () => {
  it.each(PHONE_RULE_TABLE)('%s is %s, masked %s', (input, full, masked) => {
    const attempt: AgencyReservedAttempt = {
      ...BASE,
      facts: {
        name: 'Sunita Patil',
        tiles: [{ column: 'Alt phone', label: 'Other number', key: 'alt_phone', type: 'phone', raw: input, value: parsePhoneFact(input) }],
      },
    };
    for (const [phoneDisplay, shown] of [['full', full], ['masked', masked]] as const) {
      render(<CustomerCardView card={customerCard(attempt, DISPLAY, { phoneDisplay, now: NOW })} />);
      const tile = screen.getByTestId('customer-fact');
      expect(within(tile).getByTestId('customer-fact-value').textContent).toBe(shown);
      expect(tile.getAttribute('aria-label')).toBe(`Other number: ${shown}`);
      fireEvent.focus(tile);
      expect(screen.getByRole('tooltip').textContent).toBe(`Other number${shown}From column: Alt phone`);
      cleanup();
    }
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
