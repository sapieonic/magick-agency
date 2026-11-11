import { useState, useEffect, useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useTenant } from '../../contexts/TenantContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { useCustomerSearchRun } from '../../hooks/useCustomerSearchRun';
import {
  FALLBACK_SEARCH_CALLING_CODE,
  loadCustomerSearchDefaultCallingCode,
} from '../../hooks/useCustomerSearchDefaultCallingCode';
import { listAgencyCampaigns } from '../../api/agencyCampaigns';
import { browserStorage } from '../../utils/customerSearchRecent';
import { DIALER_FLAG, type GateInput } from '../../utils/consoleNav';
import {
  canSearchCampaigns,
  canSearchNumbers,
  searchConsole,
  searchPlaceholder,
  type CampaignSettingsSection,
  type SearchCampaign,
  type SearchResult,
} from '../../utils/consoleSearch';
import styles from './GlobalSearch.module.css';

/*
 * The sections of a campaign's Settings page, linked as `…/settings#<id>`.
 * TODO(B28 search): replace this line with
 * `import { CAMPAIGN_SETTINGS_SECTIONS } from '../../utils/campaignSettingsSections';`
 * once the campaign settings sections land.
 */
const CAMPAIGN_SETTINGS_SECTIONS: readonly CampaignSettingsSection[] = [];

/** Where customer history opens inside the console shell (`docs/customer-history.md` §5). */
const CUSTOMER_RESULTS_PATH = '/agency/customers';

export interface GlobalSearchProps {
  /** Controlled: the shell opens it from the top bar's search field. Uncontrolled without it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * ⌘K / Ctrl+K, and the top bar's search field (decision B28): one search for pages, Settings,
 * campaigns and a phone number's history, each result offered under its destination's gate
 * (`utils/consoleSearch.ts`). Escape, a click outside or ⌘K again closes it and puts focus back
 * where it was (the top bar's field, when that opened it); choosing a result leaves focus to the
 * page it opens.
 */
export function GlobalSearch({ open: openProp, onOpenChange }: GlobalSearchProps = {}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const openRef = useRef(open);
  openRef.current = open;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

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

/** The reader's gates, with Missed calls' rule read only where the dialer can have it. */
function SearchDialog({ onClose }: DialogProps) {
  const { role, accountId } = useTenant();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const base: GateInput = { role, isFlagEnabled, isCapabilityEnabled };
  const dialerOn = isCapabilityEnabled('agency') && isFlagEnabled(DIALER_FLAG);
  if (dialerOn && accountId) return <DialogWithMissed base={base} onClose={onClose} />;
  return <Palette gate={base} onClose={onClose} />;
}

function DialogWithMissed({ base, onClose }: DialogProps & { base: GateInput }) {
  // Shares the sidebar's read (`useMissedCallsCount`), so opening search asks for nothing new.
  const missed = useMissedCallsAccess();
  return <Palette gate={{ ...base, missedAvailable: missed.available }} onClose={onClose} />;
}

type CampaignsState =
  | { status: 'idle' | 'loading' | 'error'; campaigns: null }
  | { status: 'ready'; campaigns: SearchCampaign[] };

/**
 * The account's campaigns, read once as the search opens (never per keystroke) and kept while it
 * is open; nothing is read for a reader the Campaigns page is not offered to.
 */
function useSearchCampaigns(allowed: boolean, tenantId: string | null, accountId: string | null): CampaignsState {
  const [state, setState] = useState<CampaignsState>({ status: 'idle', campaigns: null });
  useEffect(() => {
    if (!allowed || !accountId) return undefined;
    let live = true;
    setState({ status: 'loading', campaigns: null });
    listAgencyCampaigns(tenantId ?? undefined, accountId).then(
      (rows) => {
        if (live) setState({ status: 'ready', campaigns: rows.map((c) => ({ id: c.id, name: c.name })) });
      },
      () => {
        if (live) setState({ status: 'error', campaigns: null });
      },
    );
    return () => {
      live = false;
    };
  }, [allowed, tenantId, accountId]);
  return state;
}

/** The customer-search country's calling code, read only for a reader who may search numbers. */
function useDefaultCallingCode(allowed: boolean, tenantId: string | null, accountId: string | null): string {
  const [code, setCode] = useState(FALLBACK_SEARCH_CALLING_CODE);
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    void loadCustomerSearchDefaultCallingCode(tenantId ?? undefined, accountId ?? undefined).then((value) => {
      if (live) setCode(value);
    });
    return () => {
      live = false;
    };
  }, [allowed, tenantId, accountId]);
  return code;
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
  const callingCode = useDefaultCallingCode(numbersAllowed, tenantId ?? null, accountId ?? null);
  const campaigns = useSearchCampaigns(campaignsAllowed, tenantId ?? null, accountId ?? null);
  const numberSearch = useCustomerSearchRun(CUSTOMER_RESULTS_PATH, store);
  const placeholder = searchPlaceholder(numbersAllowed, campaignsAllowed);

  const answer = useMemo(
    () =>
      searchConsole({
        query,
        gate,
        accountId: accountId ?? null,
        defaultCallingCode: callingCode,
        campaigns: campaigns.campaigns,
        campaignSections: CAMPAIGN_SETTINGS_SECTIONS,
      }),
    // `gate` is rebuilt on each render from stable readers; its parts are what matter.
    [query, gate.role, gate.isFlagEnabled, gate.isCapabilityEnabled, gate.missedAvailable, accountId, callingCode, campaigns],
  );
  const flat = useMemo(() => answer.groups.flatMap((g) => g.results), [answer]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
      if (numberSearch.busy) return;
      void numberSearch.run(result.target.raw, result.target.countryIso).then((opened) => {
        if (opened) onClose(false);
      });
    },
    [navigate, onClose, numberSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
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
  const status = numberSearch.busy
    ? 'Searching…'
    : flat.length === 0
      ? trimmed === '' ? '' : 'No results'
      : `${flat.length} ${flat.length === 1 ? 'result' : 'results'}`;
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
              numberSearch.clearError();
            }}
          />
          <kbd className={styles.escKey} aria-hidden="true">Esc</kbd>
        </div>

        {answer.numberNote && (
          <p className={styles.note} data-testid="global-search-number-note">{answer.numberNote}</p>
        )}
        {numberSearch.error && (
          <p className={styles.error} role="alert" data-testid="global-search-error">{numberSearch.error}</p>
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
