import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  formatSearchNumber,
  parseSearchNumber,
  searchCountryByIso,
} from '@magick-agency/domain/customer-search-number';
import { customerHistoryFixture, customerSearchNumberCases } from '../helpers/customerHistory';

/**
 * The customer-history search box (`docs/customer-history.md` CH5, CH6, CH11).
 *
 * Pinned: the helper text, the live preview and the refusals come from the SHARED
 * number rule (the same table the server and the agent app run, iterated below
 * through the box itself); a search posts the raw text and the picked country; the
 * results open with only the search id in history state, never the number in the
 * URL; recent searches are the last five E.164s on this device, with Clear.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  searchCustomers: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/customerHistory', () => ({ searchCustomers: mocks.searchCustomers }));

import { CustomerSearchBox, customerSearchFeedback } from '../../components/agency/customers/CustomerSearchBox';
import { customerSearchAnswer } from '../../utils/customerHistoryStore';
import { RECENT_CUSTOMER_SEARCHES_KEY } from '../../utils/customerSearchRecent';
import { ApiError } from '../../api/client';

const fixture = customerHistoryFixture();

/** An in-memory `Storage`, so the tests never touch the real one. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

let lastLocation: ReturnType<typeof useLocation> | null = null;
function LocationProbe() {
  lastLocation = useLocation();
  return <div data-testid="results-page">results</div>;
}

function renderBox(storage: Storage = memoryStorage()) {
  render(
    <MemoryRouter initialEntries={['/agency/campaigns']}>
      <Routes>
        <Route path="/agency/campaigns" element={<CustomerSearchBox resultsPath="/agency/customers" storage={storage} />} />
        <Route path="/agency/customers" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return storage;
}

const input = () => screen.getByLabelText('Phone number') as HTMLInputElement;
const country = () => screen.getByLabelText('Country') as HTMLSelectElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  lastLocation = null;
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.searchCustomers.mockResolvedValue(fixture.search_response);
});

describe('the helper text and the country picker', () => {
  it('always shows both helper lines, naming the picked country code', () => {
    renderBox();
    expect(
      screen.getByText('Type the full mobile number. You can include or leave out +91, spaces, dashes or a leading 0.'),
    ).toBeTruthy();
    expect(
      screen.getByText('For a number from another country, pick the country or start with + and the country code.'),
    ).toBeTruthy();

    fireEvent.change(country(), { target: { value: 'GB' } });
    expect(
      screen.getByText('Type the full mobile number. You can include or leave out +44, spaces, dashes or a leading 0.'),
    ).toBeTruthy();
  });

  it('defaults to India, the platform default, and offers every country of the shared table', () => {
    renderBox();
    expect(country().value).toBe('IN');
    const isos = [...country().options].map((o) => o.value);
    for (const c of customerSearchNumberCases()) expect(isos).toContain(c.country);
  });

  it('labels the controls and ties the input to its help and feedback', () => {
    renderBox();
    expect(screen.getByRole('search', { name: 'Search a number' })).toBeTruthy();
    const describedBy = input().getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
    for (const id of describedBy.split(' ')) expect(document.getElementById(id)).toBeTruthy();
  });
});

describe('the live preview and the refusals', () => {
  it('previews the number it will search', () => {
    renderBox();
    type('098765-43210');
    expect(screen.getByTestId('customer-search-preview').textContent).toBe("We'll search for +91 98765 43210");
  });

  it('says nothing while the box is empty, and asks for a number on an empty submit', () => {
    renderBox();
    expect(screen.queryByTestId('customer-search-error')).toBeNull();
    expect(screen.queryByTestId('customer-search-preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByTestId('customer-search-error').textContent).toBe('Type a phone number to search.');
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
  });

  it.each([
    ['43210', "Enter the full number. Searching by the last few digits isn't supported."],
    ['98765abc10', 'Only digits, spaces, +, dashes and brackets are allowed.'],
    ['9.18765E+11', 'This looks like a number Excel shortened. Copy it from the cell as text.'],
    ['98765 432100', "This doesn't look like a valid Indian mobile number. Check the digits, or pick another country."],
  ])('refuses %s with the shared message', (raw, message) => {
    renderBox();
    type(raw);
    expect(screen.getByTestId('customer-search-error').textContent).toBe(message);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
  });

  it('names the picked country in the "not valid" refusal', () => {
    renderBox();
    fireEvent.change(country(), { target: { value: 'GB' } });
    type('020 7946 00189');
    expect(screen.getByTestId('customer-search-error').textContent).toBe(
      "This doesn't look like a valid UK number. Check the digits, or pick another country.",
    );
  });

  /**
   * The preview and the server run ONE rule, held to one table (CH5). Every row of
   * `customer-search-numbers.json` goes through the box as a person would type it,
   * and the box must show exactly the row's preview or refusal.
   */
  it('shows, for every row of the shared number table, exactly what the table says', () => {
    const cases = customerSearchNumberCases();
    expect(cases.length).toBeGreaterThan(30);
    renderBox();
    for (const row of cases) {
      fireEvent.change(country(), { target: { value: row.country } });
      type(row.input);
      if (row.input.trim() === '') fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      if ('e164' in row) {
        expect(screen.getByTestId('customer-search-preview').textContent, row.input).toBe(
          `We'll search for ${row.formatted}`,
        );
        expect(screen.queryByTestId('customer-search-error'), row.input).toBeNull();
      } else {
        expect(screen.getByTestId('customer-search-error').textContent, row.input).toBe(row.message);
        expect(screen.queryByTestId('customer-search-preview'), row.input).toBeNull();
      }
      type('');
    }
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
  });

  it('is the domain module, not a copy: the pure feedback agrees with parseSearchNumber row by row', () => {
    for (const row of customerSearchNumberCases()) {
      const c = searchCountryByIso(row.country)!;
      const parsed = parseSearchNumber(row.input, c);
      const feedback = customerSearchFeedback(row.input, c, true);
      if (parsed.ok) {
        expect(feedback).toEqual({ kind: 'preview', text: `We'll search for ${parsed.formatted}`, e164: parsed.e164 });
        expect(formatSearchNumber(parsed.e164)).toBe(parsed.formatted);
      } else {
        expect(feedback).toEqual({ kind: 'error', text: parsed.message });
      }
    }
  });
});

describe('searching', () => {
  it('posts the raw text and the picked country, then opens the results with only the search id', async () => {
    const storage = renderBox();
    type(' 098765-43210 ');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '098765-43210', country: 'IN' },
      'tenant-1',
      'account-1',
    );
    expect(lastLocation!.pathname).toBe('/agency/customers');
    expect(lastLocation!.search).toBe('');
    expect(lastLocation!.hash).toBe('');
    expect(lastLocation!.state).toEqual({ searchId: fixture.search_response.search_id });
    expect(JSON.stringify(lastLocation)).not.toContain('9876543210');
    expect(customerSearchAnswer(fixture.search_response.search_id)).toEqual(fixture.search_response);
    expect(JSON.parse(storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY)!)).toEqual([
      { e164: '+919876543210', country: 'IN' },
    ]);
  });

  it('submits on Enter', async () => {
    renderBox();
    type('9876543210');
    fireEvent.submit(input().form!);
    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledTimes(1);
  });

  it('shows the server refusal when the number is refused', async () => {
    mocks.searchCustomers.mockRejectedValue(new ApiError(400, fixture.error_invalid_number));
    renderBox();
    type('9876543210');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findByTestId('customer-search-error')).textContent).toBe(fixture.error_invalid_number.message);
  });

  it('says how long to wait when the per-user cap is hit (429)', async () => {
    mocks.searchCustomers.mockRejectedValue(
      new ApiError(429, { error: 'Too Many Requests', message: 'Rate limit exceeded', retryAfter: 42 }),
    );
    renderBox();
    type('9876543210');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findByTestId('customer-search-error')).textContent).toBe(
      "You've searched a lot of numbers in a short time. Try again in 42 seconds.",
    );
  });

  it('renders nothing for a role without agency.customer_history.read', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: 'a', role: undefined });
    renderBox();
    expect(screen.queryByLabelText('Phone number')).toBeNull();
  });
});

describe('recent searches', () => {
  const seeded = () =>
    memoryStorage({
      [RECENT_CUSTOMER_SEARCHES_KEY]: JSON.stringify([
        { e164: '+442079460018', country: 'GB' },
        { e164: '+919876543210', country: 'IN' },
      ]),
    });

  it('lists the numbers searched on this device, formatted', () => {
    renderBox(seeded());
    const list = screen.getByTestId('customer-search-recent');
    expect(list.textContent).toContain('Recent searches on this device');
    expect(screen.getByRole('button', { name: '+44 20 7946 0018' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+91 98765 43210' })).toBeTruthy();
  });

  it('searches a recent number again with its country', async () => {
    renderBox(seeded());
    fireEvent.click(screen.getByRole('button', { name: '+44 20 7946 0018' }));
    await waitFor(() =>
      expect(mocks.searchCustomers).toHaveBeenCalledWith(
        { by: 'phone', value: '+442079460018', country: 'GB' },
        'tenant-1',
        'account-1',
      ),
    );
  });

  it('Clear forgets them on this device', () => {
    const storage = renderBox(seeded());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('customer-search-recent')).toBeNull();
    expect(storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY)).toBeNull();
  });
});
