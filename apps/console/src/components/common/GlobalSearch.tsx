import { useState, useEffect, useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useTenant } from '../../contexts/TenantContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { useCustomerSearchRun } from '../../hooks/useCustomerSearchRun';
import { useCustomerSearchDefaultCallingCode } from '../../hooks/useCustomerSearchDefaultCallingCode';
import { useSearchCampaigns } from '../../hooks/useSearchCampaigns';
import { browserStorage } from '../../utils/customerSearchRecent';
import { plural } from '../../utils/format/number';
import { dialerOn, type GateInput } from '../../utils/consoleNav';
import {
  canSearchCampaigns,
  canSearchNumbers,
  searchConsole,
  searchPlaceholder,
  type SearchResult,
} from '../../utils/consoleSearch';
import styles from './GlobalSearch.module.css';

/** Where customer history opens inside the console shell (`docs/customer-history.md` §5). */
const CUSTOMER_RESULTS_PATH = '/agency/customers';

export interface GlobalSearchProps {
  /** The shell holds it, so the top bar's search field can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K / Ctrl+K, and the top bar's search field (decision B28): one search for pages, Settings,
 * campaigns and a phone number's history, each result offered under its destination's gate
 * (`utils/consoleSearch.ts`). Escape, a click outside or ⌘K again closes it and puts focus back
 * where it was (the top bar's field, when that opened it); choosing a result leaves focus to the
 * page it opens.
 */
export function GlobalSearch({ open, onOpenChange: setOpen }: GlobalSearchProps) {
  const openRef = useRef(open);
  openRef.current = open;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Remember what had focus as it opens (the dialog's input takes it a moment later).
  useLayoutEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  /** `restoreFocus`: closed without choosing, so focus goes back to where it was. */
  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (restoreFocus && target && target !== document.body && target.isConnected) target.focus();
    },
    [setOpen],
  );

  // Global shortcut: Cmd+K / Ctrl+K toggles.
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (openRef.current) close(true);
        else setOpen(true);
      }
    }
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [close, setOpen]);

  if (!open) return null;
  return <SearchDialog onClose={close} />;
}

interface DialogProps {
  onClose: (restoreFocus: boolean) => void;
}

/**
 * The reader's gates, with Missed calls' rule read only where the dialer can have it.
 *
 * One tree whatever resolves while it is open: the palette is always the second child, and the
 * missed-calls reader beside it comes and goes, so flags or the account arriving never remount
 * the palette and lose what was typed.
 */
function SearchDialog({ onClose }: DialogProps) {
  const { role, accountId } = useTenant();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const [missedAvailable, setMissedAvailable] = useState<boolean | undefined>(undefined);
  const readMissed = dialerOn({ isFlagEnabled, isCapabilityEnabled }) && Boolean(accountId);
  const gate: GateInput = {
    role,
    isFlagEnabled,
    isCapabilityEnabled,
    ...(readMissed && missedAvailable !== undefined ? { missedAvailable } : {}),
  };
  return (
    <>
      {readMissed ? <MissedAccessReader onRead={setMissedAvailable} /> : null}
      <Palette gate={gate} onClose={onClose} />
    </>
  );
}

/** Shares the sidebar's read (`useMissedCallsCount`), so opening search asks for nothing new. */
function MissedAccessReader({ onRead }: { onRead: (available: boolean) => void }) {
  const { available } = useMissedCallsAccess();
  useEffect(() => {
    onRead(available);
  }, [available, onRead]);
  return null;
}

function Palette({ gate, onClose }: DialogProps & { gate: GateInput }) {
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const store = useMemo(() => browserStorage(), []);
  const id = useId();
  const listboxId = `${id}-results`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const numbersAllowed = canSearchNumbers(gate, accountId ?? null);
  const campaignsAllowed = canSearchCampaigns(gate, accountId ?? null);
  const callingCode = useCustomerSearchDefaultCallingCode(numbersAllowed);
  const campaigns = useSearchCampaigns(campaignsAllowed, tenantId ?? null, accountId ?? null);
  const { run: runNumberSearch, busy: numberBusy, error: numberError, clearError: clearNumberError } =
    useCustomerSearchRun(CUSTOMER_RESULTS_PATH, store);
  const placeholder = searchPlaceholder(numbersAllowed, campaignsAllowed);

  const answer = useMemo(
    () =>
      searchConsole({
        query,
        gate,
        accountId: accountId ?? null,
        defaultCallingCode: callingCode,
        campaigns: campaigns.campaigns,
      }),
    // `gate` is rebuilt on each render from stable readers; its parts are what matter.
    [query, gate.role, gate.isFlagEnabled, gate.isCapabilityEnabled, gate.missedAvailable, accountId, callingCode, campaigns],
  );
  const flat = useMemo(() => answer.groups.flatMap((g) => g.results), [answer]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const target = resultsRef.current?.querySelector<HTMLElement>(`[data-result-index="${selectedIndex}"]`);
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const choose = useCallback(
    (result: SearchResult | undefined) => {
      if (!result) return;
      if (result.target.type === 'path') {
        navigate(result.target.to);
        onClose(false);
        return;
      }
      if (numberBusy) return;
      void runNumberSearch(result.target.raw, result.target.countryIso).then((opened) => {
        if (opened) onClose(false);
      });
    },
    [navigate, onClose, numberBusy, runNumberSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The topmost layer only: the phone's navigation drawer under it, and the profile menu,
        // skip an Escape already handled (`defaultPrevented`), and it goes no further anyway.
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (flat.length > 0) setSelectedIndex((prev) => (prev < flat.length - 1 ? prev + 1 : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (flat.length > 0) setSelectedIndex((prev) => (prev > 0 ? prev - 1 : flat.length - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        choose(flat[selectedIndex]);
        return;
      }
      // Focus stays on the input: the results are reached with the arrow keys.
      if (e.key === 'Tab') e.preventDefault();
    },
    [onClose, flat, selectedIndex, choose],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose(true);
    },
    [onClose],
  );

  const trimmed = query.trim();
  const campaignsLoading = campaignsAllowed && trimmed !== '' && campaigns.status === 'loading';
  const campaignsFailed = campaignsAllowed && trimmed !== '' && campaigns.status === 'error';
  const status = numberBusy
    ? 'Searching…'
    : flat.length === 0
      ? trimmed === '' ? '' : 'No results'
      : plural(flat.length, 'result');
  const active = flat[selectedIndex];

  let flatIndex = -1;

  return (
    /*
      `ph-no-capture`: a phone number can be typed here and shown in a result, and PostHog
      autocapture records a clicked element's text (CH6: the number never reaches analytics),
      as the old "Search a number" panel was.
    */
    <div
      className={`${styles.overlay} ph-no-capture`}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      data-testid="global-search-dialog"
    >
      <div className={styles.container} onKeyDown={handleKeyDown}>
        <div className={styles.inputWrapper}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(selectedIndex) : undefined}
            aria-label={placeholder}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
              clearNumberError();
            }}
          />
          <kbd className={styles.escKey} aria-hidden="true">Esc</kbd>
        </div>

        {answer.numberNote && (
          <p className={styles.note} data-testid="global-search-number-note">{answer.numberNote}</p>
        )}
        {numberError && (
          <p className={styles.error} role="alert" data-testid="global-search-error">{numberError}</p>
        )}

        <div className={styles.results} ref={resultsRef} id={listboxId} role="listbox" aria-label="Results">
          {flat.length === 0 && !campaignsLoading ? (
            <div className={styles.empty}>{trimmed === '' ? 'Nothing to search here' : `Nothing matches “${trimmed}”`}</div>
          ) : (
            answer.groups.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`${id}-group-${group.id}`}>
                <div className={styles.sectionHeader} id={`${id}-group-${group.id}`} role="presentation">{group.title}</div>
                {group.results.map((result) => {
                  flatIndex++;
                  const idx = flatIndex;
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={result.key}
                      id={optionId(idx)}
                      data-result-index={idx}
                      className={`${styles.resultItem} ${isSelected ? styles.resultItemSelected : ''}`}
                      onClick={() => choose(result)}
                      onMouseMove={() => {
                        if (selectedIndex !== idx) setSelectedIndex(idx);
                      }}
                      role="option"
                      aria-selected={isSelected}
                    >
                      <span className={styles.resultText}>
                        <span className={styles.resultLabel}>{result.title}</span>
                        {result.detail && <span className={styles.resultDetail}>{result.detail}</span>}
                      </span>
                      <span className={styles.resultSection}>{result.kind}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {campaignsLoading && <div className={styles.pending}>Loading campaigns…</div>}
          {campaignsFailed && <div className={styles.pending}>Couldn’t load campaigns. Close and open search to try again.</div>}
        </div>

        <div className={styles.srOnly} aria-live="polite" data-testid="global-search-status">{status}</div>

        <div className={styles.hintBar}>
          {numbersAllowed && <span>Type a phone number to see every call to it, across campaigns</span>}
          <span className={styles.hintKeys}>
            <span className={styles.hintKey}>&uarr;</span>
            <span className={styles.hintKey}>&darr;</span>
            {' to move  '}
            <span className={styles.hintKey}>Enter</span>
            {' to open'}
          </span>
        </div>
      </div>
    </div>
  );
}
