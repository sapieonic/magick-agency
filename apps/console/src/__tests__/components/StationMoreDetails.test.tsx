import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { CustomerCardView, forgetMoreDetails } from '../../components/agency/station/StationCustomer';
import {
  customerCard,
  MORE_DETAILS_PAUSE_MS,
  MORE_DETAILS_STEP,
  moreDetails,
  nextMoreShown,
} from '../../utils/agency/stationCustomer';
import type { AgencyContextDisplay, AgencyFactTile, AgencyReservedAttempt } from '../../types/agency';

/**
 * AS20, More details on the station's card: the server's `facts.more` minus the columns the card
 * draws, written by the station's formatter (a phone masked under masked), closed at first, opened
 * a step at a time by a downward scroll while its end is on screen (one step per pause), "Show
 * all" and "Hide", and a new customer starting closed.
 */

const NOW = new Date('2026-11-21T10:00:00Z');

const more = (column: string, raw: string, over: Partial<AgencyFactTile> = {}): AgencyFactTile => ({
  column,
  type: 'text',
  raw,
  value: null,
  ...over,
});

const DISPLAY: AgencyContextDisplay = {
  facts: [{ column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true }],
};

const MORE: AgencyFactTile[] = [
  more('Loan No', 'LN-4471'),
  more('Alt mobile', '98765 12345', { type: 'phone', value: '9876512345' }),
  more('Tenure', '24', { type: 'number', value: '24' }),
  more('Branch', 'Kothrud'),
  more('Product', 'Two-wheeler loan'),
  more('Agent remark', 'Prefers Marathi'),
];

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'EMI collections',
  contact_id: 'c-1',
  phone_e164: '+919876543321',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
  facts: {
    name: 'Sunita Patil',
    tiles: [
      { column: 'Outstanding', label: 'Amount due', key: 'amount_due', highlight: true, role: 'amount_due', type: 'money', raw: '1,25,000', value: '125000' },
    ],
    more: MORE,
  },
};

function cardFor(attempt: AgencyReservedAttempt = ATTEMPT, phoneDisplay: 'full' | 'masked' = 'masked') {
  return customerCard(attempt, DISPLAY, { phoneDisplay, now: NOW });
}

const rowsShown = () => screen.queryAllByTestId('more-detail-label').map((el) => el.textContent);

describe('moreDetails (AS20): the card model', () => {
  it('keeps the server\'s order, names each row by its column and writes values as a fact is written', () => {
    expect(cardFor().more).toEqual([
      { column: 'Loan No', value: 'LN-4471', kind: 'text' },
      { column: 'Alt mobile', value: '98••• ••345', kind: 'phone' },
      { column: 'Tenure', value: '24', kind: 'number' },
      { column: 'Branch', value: 'Kothrud', kind: 'text' },
      { column: 'Product', value: 'Two-wheeler loan', kind: 'text' },
      { column: 'Agent remark', value: 'Prefers Marathi', kind: 'text' },
    ]);
    expect(cardFor(ATTEMPT, 'full').more[1]).toEqual({ column: 'Alt mobile', value: '+91 98765 12345', kind: 'phone' });
  });

  it('a phone the server could not read is still masked under masked, on its digits', () => {
    const rows = moreDetails([more('Office', '022-2654 1234 ext', { type: 'phone' })], [], { phoneDisplay: 'masked' });
    expect(rows[0]!.value).not.toContain('2654');
  });

  it('leaves out a column the card draws as a tile, ignoring case, a repeat and an empty value', () => {
    const rows = moreDetails(
      [more('OUTSTANDING', '1,25,000'), more('Branch', 'Kothrud'), more('branch', 'Again'), more('Notes', '   ')],
      ['Outstanding'],
    );
    expect(rows.map((r) => r.column)).toEqual(['Branch']);
  });

  it('a legacy card (BE-6 tiles) leaves out the tiles it drew and keeps the ones past its three', () => {
    const legacy: AgencyReservedAttempt = {
      ...ATTEMPT,
      facts: {
        name: 'Sunita Patil',
        tiles: ['A', 'B', 'C', 'D'].map((c) => more(c, c.toLowerCase())),
        more: ['A', 'B', 'C', 'D', 'E'].map((c) => more(c, c.toLowerCase())),
      },
    };
    const card = customerCard(legacy, {}, { now: NOW });
    expect(card.facts.map((f) => f.label)).toEqual(['A', 'B', 'C']);
    expect(card.more.map((r) => r.column)).toEqual(['D', 'E']);
  });

  it('none from a server that sends no `more`, nor from a side view', () => {
    expect(cardFor({ ...ATTEMPT, facts: { ...ATTEMPT.facts!, more: undefined } }).more).toEqual([]);
    expect(customerCard({ ...ATTEMPT, facts: undefined }, DISPLAY, { now: NOW }).more).toEqual([]);
  });

  it('opens a step at a time, never past the end', () => {
    expect(nextMoreShown(0, 6)).toBe(MORE_DETAILS_STEP);
    expect(nextMoreShown(MORE_DETAILS_STEP, 6)).toBe(6);
    expect(nextMoreShown(6, 6)).toBe(6);
  });
});

describe('More details on the card (AS20)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn> | null = null;
  let onScreen = true;

  beforeEach(() => {
    onScreen = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // jsdom lays nothing out: the end of More details is on screen when the test says so.
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => (onScreen ? { top: 100, bottom: 101, left: 0, right: 10, width: 10, height: 1, x: 0, y: 100 } : { top: 5000, bottom: 5001, left: 0, right: 10, width: 10, height: 1, x: 0, y: 5000 }) as DOMRect,
    );
  });

  afterEach(() => {
    forgetMoreDetails();
    rectSpy?.mockRestore();
    vi.useRealTimers();
    cleanup();
  });

  const wheelDown = () => act(() => {
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
  });
  const later = (ms = MORE_DETAILS_PAUSE_MS + 1) => vi.setSystemTime(Date.now() + ms);

  it('is closed at first: the title, the count and the hint, no rows', () => {
    render(<CustomerCardView card={cardFor()} />);
    expect(screen.getByTestId('more-details').dataset['state']).toBe('closed');
    expect(screen.getByTestId('more-details-count').textContent).toBe('6 more');
    expect(screen.getByTestId('more-details-hint').textContent).toBe('Scroll down to see them.');
    expect(screen.getByTestId('more-details-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(rowsShown()).toEqual([]);
  });

  it('a downward scroll while its end is on screen opens a step; one step per pause; then the rest', () => {
    render(<CustomerCardView card={cardFor()} />);
    wheelDown();
    expect(rowsShown()).toEqual(['Loan No', 'Alt mobile', 'Tenure', 'Branch']);
    expect(screen.getByTestId('more-details-hint').textContent).toBe('Showing 4 of 6. Scroll down for more.');
    // The same flick of the wheel opens nothing more.
    wheelDown();
    expect(rowsShown()).toHaveLength(MORE_DETAILS_STEP);
    later();
    wheelDown();
    expect(rowsShown()).toHaveLength(6);
    expect(screen.getByTestId('more-details').dataset['state']).toBe('open');
    expect(screen.queryByTestId('more-details-hint')).toBeNull();
    expect(screen.getByTestId('more-details-toggle').textContent).toBe('Hide');
  });

  it('an upward scroll, or a scroll while its end is off screen, opens nothing', () => {
    render(<CustomerCardView card={cardFor()} />);
    act(() => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    });
    expect(rowsShown()).toEqual([]);
    onScreen = false;
    later();
    wheelDown();
    expect(rowsShown()).toEqual([]);
  });

  it('the page moving down opens a step too', () => {
    render(<CustomerCardView card={cardFor()} />);
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: 200, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    expect(rowsShown()).toHaveLength(MORE_DETAILS_STEP);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('Show all opens every row at once and Hide closes them', () => {
    render(<CustomerCardView card={cardFor()} />);
    fireEvent.click(screen.getByTestId('more-details-toggle'));
    expect(rowsShown()).toHaveLength(6);
    const toggle = screen.getByTestId('more-details-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull();
    fireEvent.click(toggle);
    expect(rowsShown()).toEqual([]);
  });

  it('values are plain text, a masked phone included', () => {
    render(<CustomerCardView card={cardFor({ ...ATTEMPT, facts: { ...ATTEMPT.facts!, more: [more('Alt mobile', '98765 12345', { type: 'phone', value: '9876512345' }), more('Html', '<b>bold</b>')] } })} />);
    fireEvent.click(screen.getByTestId('more-details-toggle'));
    const values = screen.getAllByTestId('more-detail-value').map((el) => el.textContent);
    expect(values).toEqual(['98••• ••345', '<b>bold</b>']);
    expect(document.querySelector('[data-testid="more-details"] b')).toBeNull();
  });

  it('the same call drawn again opens as far as it was left; another call starts closed', () => {
    const { unmount } = render(<CustomerCardView card={cardFor()} />);
    wheelDown();
    unmount();
    render(<CustomerCardView card={cardFor()} />);
    expect(rowsShown()).toHaveLength(MORE_DETAILS_STEP);
    cleanup();
    render(<CustomerCardView card={cardFor({ ...ATTEMPT, attempt_id: 'att-2' })} />);
    expect(rowsShown()).toEqual([]);
  });

  it('no More details when there is nothing more, nor on the compact card', () => {
    render(<CustomerCardView card={cardFor({ ...ATTEMPT, facts: { ...ATTEMPT.facts!, more: [] } })} />);
    expect(screen.queryByTestId('more-details')).toBeNull();
    cleanup();
    render(<CustomerCardView card={cardFor()} compact />);
    expect(screen.queryByTestId('more-details')).toBeNull();
  });
});
