import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import {
  formatSearchNumber,
  parseSearchNumber,
  resolveSearchCountry,
  searchCountryOptions,
  type SearchCountry,
} from '@magick-agency/domain/customer-search-number';
import { CUSTOMER_SEARCH_VALUE_MAX } from '@magick-agency/contracts/api/agency/customer-history';
import { usePermission } from '../../../hooks/usePermission';
import { useCustomerSearchDefaultCallingCode } from '../../../hooks/useCustomerSearchDefaultCallingCode';
import { browserStorage } from '../../../utils/browserStorage';
import {
  clearRecentCustomerSearches,
  readRecentCustomerSearches,
  subscribeRecentCustomerSearches,
  RECENT_CUSTOMER_SEARCHES_KEY,
  type RecentCustomerSearch,
} from '../../../utils/customerSearchRecent';
import { useCustomerSearchRun } from '../../../hooks/useCustomerSearchRun';
import {
  customerSearchHelperLines,
  customerSearchPreview,
} from '../../../utils/customerHistoryCopy';
import styles from './CustomerSearchBox.module.css';

export type CustomerSearchFeedback =
  | { kind: 'preview'; formatted: string; e164: string }
  | { kind: 'error'; text: string }
  | null;

/**
 * What the box shows under the input, from the shared number rule
 * (`packages/domain/src/customer-search-number.ts`) and nothing else, so the
 * preview never promises a number the server would not search (CH5).
 *
 * `revealed`: the person submitted (Enter / Search) or left the field. Until then
 * a number that is merely not finished yet (`empty`, `too_short`) says nothing
 * beyond the always-visible helper lines: every correct number is "too short"
 * for its first nine keystrokes, and an error there would be read out by the live
 * region on each of them. A refusal that more typing cannot cure
 * (`invalid_characters`, `spreadsheet_number`, `invalid_for_country`) shows at once.
 *
 * `null`: nothing to say yet.
 */
export function customerSearchFeedback(raw: string, country: SearchCountry, revealed: boolean): CustomerSearchFeedback {
  const result = parseSearchNumber(raw, country);
  if (result.ok) {
    return { kind: 'preview', formatted: result.formatted, e164: result.e164 };
  }
  if ((result.code === 'empty' || result.code === 'too_short') && !revealed) return null;
  return { kind: 'error', text: result.message };
}

/**
 * The recent list, shared by every mounted box (the page's own and the top bar's
 * panel) and with other tabs: re-read whenever any box remembers or clears.
 */
function useRecentCustomerSearches(store: Storage | undefined): RecentCustomerSearch[] {
  const [recent, setRecent] = useState<RecentCustomerSearch[]>(() => readRecentCustomerSearches(store));
  useEffect(() => {
    const reread = () => setRecent(readRecentCustomerSearches(store));
    reread();
    const unsubscribe = subscribeRecentCustomerSearches(reread);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === RECENT_CUSTOMER_SEARCHES_KEY) reread();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, [store]);
  return recent;
}

export interface CustomerSearchBoxProps {
  /** Where the results open: `/agency/customers` in the console shell, `/dialer/customers` for an agent. */
  resultsPath: string;
  /** After a search opened its results (the topbar closes its panel). */
  onSearched?: () => void;
  autoFocus?: boolean;
  /** Injected for tests; the browser's `localStorage` otherwise. */
  storage?: Storage;
}

/**
 * "Search a number": one phone number, typed or pasted, cleaned by the shared rule,
 * searched with a `POST` (the number never goes in a URL, CH6), and opened on the
 * Customer history page with only the search id in the history state.
 */
export function CustomerSearchBox({ resultsPath, onSearched, autoFocus = false, storage }: CustomerSearchBoxProps) {
  const allowed = usePermission('agency.customer_history.read');
  const store = useMemo(() => storage ?? browserStorage(), [storage]);
  const defaultCallingCode = useCustomerSearchDefaultCallingCode();

  const [raw, setRaw] = useState('');
  /** `null` until the person picks: the picker follows the platform default until then. */
  const [countryIso, setCountryIso] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const { run: runSearch, busy, error: serverError, clearError: clearServerError } = useCustomerSearchRun(resultsPath, store);
  const recent = useRecentCustomerSearches(store);
  const inputRef = useRef<HTMLInputElement>(null);

  const id = useId();
  const inputId = `${id}-number`;
  const countryId = `${id}-country`;
  const helpId = `${id}-help`;
  const feedbackId = `${id}-feedback`;

  const country = useMemo(() => resolveSearchCountry(countryIso, defaultCallingCode), [countryIso, defaultCallingCode]);
  const countries = useMemo(() => searchCountryOptions(defaultCallingCode), [defaultCallingCode]);
  const feedback = customerSearchFeedback(raw, country, revealed);
  const [helpLine1, helpLine2] = customerSearchHelperLines(country);

  const run = useCallback(
    async (value: string, iso: string) => {
      if (await runSearch(value, iso)) {
        setRaw('');
        setRevealed(false);
        onSearched?.();
      }
    },
    [runSearch, onSearched],
  );

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      setRevealed(true);
      if (busy) return;
      const result = parseSearchNumber(raw, country);
      if (!result.ok) {
        clearServerError();
        inputRef.current?.focus();
        return;
      }
      void run(raw.trim(), country.iso);
    },
    [busy, raw, country, run, clearServerError],
  );

  const onClearRecent = useCallback(() => {
    clearRecentCustomerSearches(store);
  }, [store]);

  if (!allowed) return null;

  const errorShown = feedback?.kind === 'error' ? feedback.text : serverError;

  return (
    /*
      `ph-no-capture`: everything in this box is a customer's phone number (what is
      typed, the preview, the recent searches' button text), and PostHog
      autocapture, rage and dead clicks are on (`analytics/posthog.ts`), recording a
      clicked element's text and attributes. The class on an ancestor stops
      posthog-js from capturing anything inside it (`analytics/autocaptureOptOut.test.ts`
      pins that the pinned version still honours it; `InviteJoinScreen` explains
      the mechanism). The whole box rather than chosen elements, so a line added
      to it later is covered too (CH6: the number never reaches analytics).
    */
    <form
      className={`${styles.box} ph-no-capture`}
      onSubmit={onSubmit}
      role="search"
      aria-label="Search a number"
      noValidate
      data-testid="customer-search-box"
    >
      <div className={styles.row}>
        <div className={styles.countryField}>
          <label htmlFor={countryId} className={styles.label}>Country</label>
          <select
            id={countryId}
            className={styles.country}
            value={country.iso}
            onChange={(e) => {
              setCountryIso(e.target.value);
              clearServerError();
            }}
          >
            {countries.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.unlisted ? c.name : `${c.name} (+${c.callingCode})`}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.numberField}>
          <label htmlFor={inputId} className={styles.label}>Phone number</label>
          <input
            ref={inputRef}
            id={inputId}
            className={styles.input}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            spellCheck={false}
            maxLength={CUSTOMER_SEARCH_VALUE_MAX}
            value={raw}
            autoFocus={autoFocus}
            onChange={(e) => {
              setRaw(e.target.value);
              clearServerError();
              // Typing again: an unfinished number goes quiet until the next submit or blur.
              setRevealed(false);
            }}
            onBlur={() => {
              if (raw.trim() !== '') setRevealed(true);
            }}
            aria-describedby={`${helpId} ${feedbackId}`}
            aria-invalid={errorShown ? true : undefined}
          />
        </div>
        <button type="submit" className={`btn-primary ${styles.submit}`} disabled={busy}>
          <Search size={15} aria-hidden="true" />
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      <div id={helpId} className={styles.help}>
        <p>{helpLine1}</p>
        <p>{helpLine2}</p>
      </div>

      <div id={feedbackId} aria-live="polite" className={styles.feedback}>
        {errorShown ? (
          <p className={styles.error} data-testid="customer-search-error">{errorShown}</p>
        ) : feedback?.kind === 'preview' ? (
          <p className={styles.preview} data-testid="customer-search-preview">
            {customerSearchPreview('')}
            <strong>{feedback.formatted}</strong>
          </p>
        ) : null}
      </div>

      {recent.length > 0 && (
        <div className={styles.recent} data-testid="customer-search-recent">
          <div className={styles.recentHeader}>
            <span className={styles.recentTitle} id={`${id}-recent`}>Recent searches on this device</span>
            <button type="button" className={styles.clear} onClick={onClearRecent} aria-label="Clear recent searches">
              <X size={13} aria-hidden="true" />
              Clear
            </button>
          </div>
          <ul className={styles.recentList} aria-labelledby={`${id}-recent`}>
            {recent.map((r) => (
              <li key={r.e164}>
                <button
                  type="button"
                  className={styles.recentItem}
                  disabled={busy}
                  onClick={() => {
                    setCountryIso(r.country);
                    void run(r.e164, r.country);
                  }}
                >
                  {formatSearchNumber(r.e164)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

export default CustomerSearchBox;
