import { useCallback, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import {
  SEARCH_COUNTRIES,
  formatSearchNumber,
  parseSearchNumber,
  resolveSearchCountry,
  type SearchCountry,
} from '@magick-agency/domain/customer-search-number';
import { CUSTOMER_SEARCH_VALUE_MAX } from '@magick-agency/contracts/api/agency/customer-history';
import { searchCustomers } from '../../../api/customerHistory';
import { useTenant } from '../../../contexts/TenantContext';
import { usePermission } from '../../../hooks/usePermission';
import {
  browserStorage,
  clearRecentCustomerSearches,
  readRecentCustomerSearches,
  rememberCustomerSearch,
  type RecentCustomerSearch,
} from '../../../utils/customerSearchRecent';
import { rememberCustomerSearchAnswer, type CustomerHistoryLocationState } from '../../../utils/customerHistoryStore';
import {
  customerHistoryRefusal,
  customerSearchHelperLines,
  customerSearchPreview,
} from '../../../utils/customerHistoryCopy';
import styles from './CustomerSearchBox.module.css';

/**
 * The platform's default calling code (`DEFAULT_PHONE_COUNTRY_CODE`, +91). The
 * console has no copy of the platform setting outside the soft phone's bootstrap,
 * which is flag-gated, so the picker defaults to the same value the server falls
 * back to when the request carries no `country`.
 */
export const DEFAULT_SEARCH_CALLING_CODE = '91';

/**
 * What the box shows under the input, from the shared number rule
 * (`packages/domain/src/customer-search-number.ts`) and nothing else, so the
 * preview never promises a number the server would not search (CH5).
 *
 * `null`: nothing to say yet (empty, and not submitted).
 */
export function customerSearchFeedback(
  raw: string,
  country: SearchCountry,
  submitted: boolean,
): { kind: 'preview'; text: string; e164: string } | { kind: 'error'; text: string } | null {
  const result = parseSearchNumber(raw, country);
  if (result.ok) return { kind: 'preview', text: customerSearchPreview(result.formatted), e164: result.e164 };
  if (result.code === 'empty' && !submitted) return null;
  return { kind: 'error', text: result.message };
}

export interface CustomerSearchBoxProps {
  /** Where the results open: `/agency/customers` in the agency shell, `/dialer/customers` for an agent. */
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
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  const store = storage ?? browserStorage();

  const [raw, setRaw] = useState('');
  const [countryIso, setCountryIso] = useState(() => resolveSearchCountry(undefined, DEFAULT_SEARCH_CALLING_CODE).iso);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentCustomerSearch[]>(() => readRecentCustomerSearches(store));
  const inputRef = useRef<HTMLInputElement>(null);

  const id = useId();
  const inputId = `${id}-number`;
  const countryId = `${id}-country`;
  const helpId = `${id}-help`;
  const feedbackId = `${id}-feedback`;

  const country = useMemo(() => resolveSearchCountry(countryIso, DEFAULT_SEARCH_CALLING_CODE), [countryIso]);
  const feedback = customerSearchFeedback(raw, country, submitted);
  const [helpLine1, helpLine2] = customerSearchHelperLines(country);

  const run = useCallback(
    async (value: string, iso: string) => {
      setBusy(true);
      setServerError(null);
      try {
        const answer = await searchCustomers(
          { by: 'phone', value, country: iso },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
        rememberCustomerSearchAnswer(answer);
        setRecent(rememberCustomerSearch(store, { e164: answer.key.value, country: iso }));
        setRaw('');
        setSubmitted(false);
        const state: CustomerHistoryLocationState = { searchId: answer.search_id };
        navigate(resultsPath, { state });
        onSearched?.();
      } catch (err: unknown) {
        setServerError(customerHistoryRefusal(err, 'Could not search this number. Try again.').message);
      } finally {
        setBusy(false);
      }
    },
    [tenantId, accountId, store, navigate, resultsPath, onSearched],
  );

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      setSubmitted(true);
      if (busy) return;
      const result = parseSearchNumber(raw, country);
      if (!result.ok) {
        setServerError(null);
        inputRef.current?.focus();
        return;
      }
      void run(raw.trim(), country.iso);
    },
    [busy, raw, country, run],
  );

  const onClearRecent = useCallback(() => {
    clearRecentCustomerSearches(store);
    setRecent([]);
  }, [store]);

  if (!allowed) return null;

  const errorShown = feedback?.kind === 'error' ? feedback.text : serverError;

  return (
    <form className={styles.box} onSubmit={onSubmit} role="search" aria-label="Search a number" noValidate>
      <div className={styles.row}>
        <div className={styles.countryField}>
          <label htmlFor={countryId} className={styles.label}>Country</label>
          <select
            id={countryId}
            className={styles.country}
            value={country.iso}
            onChange={(e) => {
              setCountryIso(e.target.value);
              setServerError(null);
            }}
          >
            {SEARCH_COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.name} (+{c.callingCode})
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
              setServerError(null);
              if (e.target.value.trim() === '') setSubmitted(false);
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
          <p className={styles.preview} data-testid="customer-search-preview">{feedback.text}</p>
        ) : null}
      </div>

      {recent.length > 0 && (
        <div className={styles.recent} data-testid="customer-search-recent">
          <div className={styles.recentHeader}>
            <span className={styles.recentTitle} id={`${id}-recent`}>Recent searches on this device</span>
            <button type="button" className={styles.clear} onClick={onClearRecent}>
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
