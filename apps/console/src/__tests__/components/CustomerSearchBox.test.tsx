import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { platformDefaultSearchCountry, searchCountryByIso } from '@magick-agency/domain/customer-search-number';
import { customerHistoryFixture, customerSearchNumberCases } from '../helpers/customerHistory';

/**
 * The customer-history search box (`docs/customer-history.md` CH5, CH6, CH11).
 *
 * Pinned: the helper text, the live preview and the refusals come from the SHARED
 * number rule (the same table the server and the agent app run, iterated below
 * through the box itself); a search posts the raw text and the picked country; the
 * results open with only the search id in history state, never the number in the
 * URL; recent searches are the last five E.164s on this device, with Clear, shared
 * by every mounted box; the number never reaches analytics (`ph-no-capture`); a
 * search nobody waits for any more is abandoned.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  searchCustomers: vi.fn(),
  getCustomerSearchOptions: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/customerHistory', () => ({
  searchCustomers: mocks.searchCustomers,
  getCustomerSearchOptions: mocks.getCustomerSearchOptions,
}));

import { CustomerSearchBox, customerSearchFeedback } from '../../components/agency/customers/CustomerSearchBox';
import { resetCustomerSearchDefaultCallingCode } from '../../hooks/useCustomerSearchDefaultCallingCode';
import { clearCustomerSearchAnswers, customerSearchAnswer } from '../../utils/customerHistoryStore';
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
  return { storage, ...renderBoxResult(storage) };
}

function renderBoxResult(storage: Storage) {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns']}>
      <Routes>
        <Route path="/agency/campaigns" element={<CustomerSearchBox resultsPath="/agency/customers" storage={storage} />} />
        <Route path="/agency/customers" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const input = () => screen.getByLabelText('Phone number') as HTMLInputElement;
const country = () => screen.getByLabelText('Country') as HTMLSelectElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  lastLocation = null;
  clearCustomerSearchAnswers();
  resetCustomerSearchDefaultCallingCode();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
  mocks.searchCustomers.mockResolvedValue(fixture.search_response);
  mocks.getCustomerSearchOptions.mockResolvedValue({ default_country_code: '+91' });
});

/** A promise the test settles itself. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it('defaults to India, the platform default, and offers every country of the shared table', async () => {
    renderBox();
    expect(country().value).toBe('IN');
    const isos = [...country().options].map((o) => o.value);
    for (const c of customerSearchNumberCases()) if (c.country !== null) expect(isos).toContain(c.country);
    // A listed default adds no entry of its own.
    expect(isos).not.toContain('');
    await waitFor(() => expect(mocks.getCustomerSearchOptions).toHaveBeenCalledTimes(1));
  });

  it("starts on the platform's configured default, read once per session from the options route", async () => {
    mocks.getCustomerSearchOptions.mockResolvedValue({ default_country_code: '+44' });
    const { unmount } = renderBox();
    // Typing is never blocked on the answer: the fallback until it arrives.
    expect(country().value).toBe('IN');
    await waitFor(() => expect(country().value).toBe('GB'));
    expect(mocks.getCustomerSearchOptions).toHaveBeenCalledWith('tenant-1', 'account-1');
    unmount();

    renderBox();
    expect(country().value).toBe('GB');
    expect(mocks.getCustomerSearchOptions).toHaveBeenCalledTimes(1);
  });

  it('uses +91 when the options read fails, and reads it again when the next box mounts', async () => {
    mocks.getCustomerSearchOptions.mockRejectedValueOnce(new ApiError(503, { message: 'Service Unavailable' }));
    mocks.getCustomerSearchOptions.mockResolvedValueOnce({ default_country_code: '+44' });
    const { unmount } = renderBox();
    await waitFor(() => expect(mocks.getCustomerSearchOptions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(country().value).toBe('IN');
    unmount();

    // The failure was not kept for the session: this mount asks again and gets the real default.
    const second = renderBox();
    await waitFor(() => expect(country().value).toBe('GB'));
    expect(mocks.getCustomerSearchOptions).toHaveBeenCalledTimes(2);
    second.unmount();

    // Once read, it is kept: no third read.
    renderBox();
    expect(country().value).toBe('GB');
    await act(async () => {});
    expect(mocks.getCustomerSearchOptions).toHaveBeenCalledTimes(2);
  });

  it('never moves a country the person picked when the default arrives', async () => {
    const options = deferred<{ default_country_code: string }>();
    mocks.getCustomerSearchOptions.mockReturnValue(options.promise);
    renderBox();
    fireEvent.change(country(), { target: { value: 'AE' } });
    await act(async () => options.resolve({ default_country_code: '+44' }));
    expect(country().value).toBe('AE');
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
    ['98765abc10', 'Only digits, spaces, +, dashes and brackets are allowed.'],
    ['9.18765E+11', 'This looks like a number Excel shortened. Copy it from the cell as text.'],
    ['98765 432100', "This doesn't look like a valid Indian mobile number. Check the digits, or pick another country."],
  ])('refuses %s with the shared message as it is typed (more digits cannot cure it)', (raw, message) => {
    renderBox();
    type(raw);
    expect(screen.getByTestId('customer-search-error').textContent).toBe(message);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocks.searchCustomers).not.toHaveBeenCalled();
  });

  const TOO_SHORT = "Enter the full number. Searching by the last few digits isn't supported.";

  it('stays quiet while a number is still being typed, then refuses a short one on Search', () => {
    renderBox();
    const live = () => input().form!.querySelector('[aria-live]')!;
    for (const partial of ['9', '98', '98765', '987654321']) {
      type(partial);
      expect(screen.queryByTestId('customer-search-error'), partial).toBeNull();
      expect(live().textContent, partial).toBe('');
      expect(input().getAttribute('aria-invalid'), partial).toBeNull();
    }
    type('43210');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByTestId('customer-search-error').textContent).toBe(TOO_SHORT);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(mocks.searchCustomers).not.toHaveBeenCalled();

    // Typing again goes quiet until the number is whole, then previews it.
    type('987654');
    expect(screen.queryByTestId('customer-search-error')).toBeNull();
    type('9876543210');
    expect(screen.getByTestId('customer-search-preview').textContent).toBe("We'll search for +91 98765 43210");
  });

  it('refuses a short number when the field is left (blur), and on Enter', () => {
    renderBox();
    type('43210');
    fireEvent.blur(input());
    expect(screen.getByTestId('customer-search-error').textContent).toBe(TOO_SHORT);
    type('432109');
    expect(screen.queryByTestId('customer-search-error')).toBeNull();
    fireEvent.submit(input().form!);
    expect(screen.getByTestId('customer-search-error').textContent).toBe(TOO_SHORT);
  });

  it('says nothing when an empty field is left', () => {
    renderBox();
    fireEvent.blur(input());
    expect(screen.queryByTestId('customer-search-error')).toBeNull();
  });

  it('shows the previewed number in bold', () => {
    renderBox();
    type('9876543210');
    expect(screen.getByTestId('customer-search-preview').querySelector('strong')?.textContent).toBe('+91 98765 43210');
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
  it('shows, for every row of the shared number table, exactly what the table says', async () => {
    const all = customerSearchNumberCases();
    expect(all.length).toBeGreaterThan(30);
    await runTableThroughBox(all.filter((row) => row.country !== null), '+91');
  });

  it('shows, for every row of an unlisted platform default, exactly what the table says', async () => {
    const rows = customerSearchNumberCases().filter((row) => row.country === null);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const code of new Set(rows.map((row) => row.defaultCallingCode!))) {
      resetCustomerSearchDefaultCallingCode();
      mocks.getCustomerSearchOptions.mockResolvedValue({ default_country_code: code });
      await runTableThroughBox(rows.filter((row) => row.defaultCallingCode === code), code);
    }
  });

  /** Each row typed into one box opened on `defaultCallingCode`, its country picked (the default's own entry for a null country). */
  async function runTableThroughBox(cases: ReturnType<typeof customerSearchNumberCases>, defaultCallingCode: string) {
    const { unmount } = renderBox();
    await waitFor(() => expect(country().value).toBe(platformDefaultSearchCountry(defaultCallingCode).iso));
    for (const row of cases) {
      fireEvent.change(country(), { target: { value: row.country ?? '' } });
      type(row.input);
      // An unfinished number speaks only once submitted; the rest speak as typed.
      if ('error' in row && (row.error === 'empty' || row.error === 'too_short')) {
        expect(screen.queryByTestId('customer-search-error'), row.input).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      }
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
    unmount();
  }

  /**
   * When each refusal may speak, over the whole table: `empty` and `too_short` only
   * once revealed (submit or blur), every other refusal at once, and a valid number
   * always previews. The table's own expectations, not `parseSearchNumber`'s, so a
   * drift in either side shows here.
   */
  it('holds back only the "not finished yet" refusals until revealed, row by row', () => {
    const codes = new Set<string>();
    for (const row of customerSearchNumberCases()) {
      const c = row.country === null ? platformDefaultSearchCountry(row.defaultCallingCode!) : searchCountryByIso(row.country)!;
      const typing = customerSearchFeedback(row.input, c, false);
      const revealed = customerSearchFeedback(row.input, c, true);
      if ('e164' in row) {
        for (const f of [typing, revealed]) {
          expect(f, row.input).toEqual({
            kind: 'preview',
            formatted: row.formatted,
            e164: row.e164,
          });
        }
        continue;
      }
      codes.add(row.error);
      expect(revealed, row.input).toEqual({ kind: 'error', text: row.message });
      if (row.error === 'empty' || row.error === 'too_short') expect(typing, row.input).toBeNull();
      else expect(typing, row.input).toEqual({ kind: 'error', text: row.message });
    }
    // The table exercises both sides of the rule.
    expect(codes).toContain('too_short');
    expect(codes).toContain('invalid_characters');
  });
});

/**
 * A platform default the picker does not list (`DEFAULT_PHONE_COUNTRY_CODE=27`) is never shown or
 * searched as India: the picker opens on an entry of its own named by the calling code, the
 * number is read by the roster ingest's rule for it, and the search names it by sending no
 * `country` (absent = the platform default).
 */
describe('an unlisted platform default', () => {
  beforeEach(() => {
    mocks.getCustomerSearchOptions.mockResolvedValue({ default_country_code: '+27' });
  });

  it('opens on its own entry, first in the picker, labelled by its calling code', async () => {
    renderBox();
    await waitFor(() => expect(country().value).toBe(''));
    const options = [...country().options];
    expect(options[0]!.textContent).toBe('+27');
    expect(options[0]!.selected).toBe(true);
    expect(options[1]!.textContent).toBe('India (+91)');
    expect(
      screen.getByText('Type the full mobile number. You can include or leave out +27, spaces, dashes or a leading 0.'),
    ).toBeTruthy();
    type('27 82 123 4567');
    expect(screen.getByTestId('customer-search-preview').textContent).toBe("We'll search for +27821234567");
  });

  it('searches with no country, and remembers it with no ISO', async () => {
    const { storage } = renderBox();
    await waitFor(() => expect(country().value).toBe(''));
    type('27821234567');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '27821234567' },
      'tenant-1',
      'account-1',
      expect.any(AbortSignal),
    );
    expect(JSON.parse(storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY)!)[0]).toMatchObject({ country: '' });
  });

  it('a recent search made in it runs again with no country', async () => {
    renderBox(memoryStorage({ [RECENT_CUSTOMER_SEARCHES_KEY]: JSON.stringify([{ e164: '+27821234567', country: '' }]) }));
    await waitFor(() => expect(country().value).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: '+27821234567' }));
    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '+27821234567' },
      'tenant-1',
      'account-1',
      expect.any(AbortSignal),
    );
  });

  it('a listed country picked over it is sent by its ISO', async () => {
    renderBox();
    await waitFor(() => expect(country().value).toBe(''));
    fireEvent.change(country(), { target: { value: 'GB' } });
    type('020 7946 0018');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '020 7946 0018', country: 'GB' },
      'tenant-1',
      'account-1',
      expect.any(AbortSignal),
    );
  });
});

describe('searching', () => {
  it('posts the raw text and the picked country, then opens the results with only the search id', async () => {
    const { storage } = renderBox();
    type(' 098765-43210 ');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByTestId('results-page');
    expect(mocks.searchCustomers).toHaveBeenCalledWith(
      { by: 'phone', value: '098765-43210', country: 'IN' },
      'tenant-1',
      'account-1',
      expect.any(AbortSignal),
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

  it('abandons a search still in flight when the person moves on, and never navigates for it', async () => {
    const answer = deferred<typeof fixture.search_response>();
    mocks.searchCustomers.mockReturnValue(answer.promise);
    let where: string | null = null;
    function Probe({ name }: { name: string }) {
      where = `${name}:${useLocation().pathname}`;
      return <div data-testid={name} />;
    }
    render(
      <MemoryRouter initialEntries={['/agency/campaigns']}>
        <Routes>
          <Route
            path="/agency/campaigns"
            element={
              <>
                <CustomerSearchBox resultsPath="/agency/customers" storage={memoryStorage()} />
                <Link to="/agency/roster">Roster</Link>
              </>
            }
          />
          <Route path="/agency/roster" element={<Probe name="roster" />} />
          <Route path="/agency/customers" element={<Probe name="results" />} />
        </Routes>
      </MemoryRouter>,
    );
    type('9876543210');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const signal = mocks.searchCustomers.mock.calls[0]![3] as AbortSignal;
    expect(signal.aborted).toBe(false);

    // The box goes (as the top bar's panel does when closed); the router stays.
    fireEvent.click(screen.getByRole('link', { name: 'Roster' }));
    expect(screen.getByTestId('roster')).toBeTruthy();
    expect(signal.aborted).toBe(true);

    // A server that answers anyway must not pull them off the page they went to.
    await act(async () => answer.resolve(fixture.search_response));
    expect(where).toBe('roster:/agency/roster');
    expect(screen.queryByTestId('results')).toBeNull();
    expect(customerSearchAnswer(fixture.search_response.search_id)).toBeNull();
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
        expect.any(AbortSignal),
      ),
    );
  });

  it('Clear recent searches forgets them on this device', () => {
    const { storage } = renderBox(seeded());
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent searches' }));
    expect(screen.queryByTestId('customer-search-recent')).toBeNull();
    expect(storage.getItem(RECENT_CUSTOMER_SEARCHES_KEY)).toBeNull();
  });

  it('is one list for every mounted box: a search or a clear in one shows in the other', async () => {
    const storage = seeded();
    render(
      <MemoryRouter>
        <div data-testid="box-a"><CustomerSearchBox resultsPath="/agency/customers" storage={storage} /></div>
        <div data-testid="box-b"><CustomerSearchBox resultsPath="/agency/customers" storage={storage} /></div>
      </MemoryRouter>,
    );
    const inputA = screen.getAllByLabelText('Phone number')[0] as HTMLInputElement;
    const lists = () => screen.getAllByTestId('customer-search-recent').map((l) => l.textContent);

    mocks.searchCustomers.mockResolvedValue({
      ...fixture.search_response,
      key: { ...fixture.search_response.key, value: '+919876500000', display: '+91 98765 00000' },
    });
    expect(lists().every((t) => !t!.includes('+91 98765 00000'))).toBe(true);
    fireEvent.change(inputA, { target: { value: '9876500000' } });
    fireEvent.submit(inputA.form!);
    // Searched in box A; box B (the page's own box, say) lists it too.
    await waitFor(() => expect(lists()).toHaveLength(2));
    await waitFor(() => expect(lists().every((t) => t!.includes('+91 98765 00000'))).toBe(true));

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear recent searches' })[1]!);
    expect(screen.queryAllByTestId('customer-search-recent')).toHaveLength(0);
  });
});

describe('what analytics may see', () => {
  it('keeps the whole box, its preview and its recent searches inside a ph-no-capture boundary', () => {
    renderBox(
      memoryStorage({ [RECENT_CUSTOMER_SEARCHES_KEY]: JSON.stringify([{ e164: '+919876543210', country: 'IN' }]) }),
    );
    type('098765-43210');
    const box = screen.getByTestId('customer-search-box');
    expect(box.classList.contains('ph-no-capture')).toBe(true);
    for (const el of [
      input(),
      screen.getByTestId('customer-search-preview'),
      screen.getByTestId('customer-search-recent'),
      screen.getByRole('button', { name: '+91 98765 43210' }),
    ]) {
      expect(el.closest('.ph-no-capture')).toBe(box);
    }
  });
});
