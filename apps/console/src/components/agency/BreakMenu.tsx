import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { typeaheadIndex } from '../../utils/agencyCatalogSync';
import type { AgencyBreakReason } from '../../types/agency';
import styles from './BreakMenu.module.css';

/**
 * `Break ▾` and its popover.
 *
 * ── Number keys are NOT bound here, and that is a decision, not an omission ───
 * `1`–`9` belong to the disposition pad. Reassigning them by context is
 * how muscle memory gets destroyed — an agent who has learned "3 = voicemail"
 * must not find that `3` means "Meeting" whenever a popover happens to be open.
 * The menu is arrows + `Enter` + first-letter typeahead, and the typeahead
 * deliberately refuses digits so a number key cannot become a binding by the back
 * door.
 *
 * The list-and-re-sync concern is shared with `DispositionPad` through
 * `agencyCatalogSync` — the API made `break_reasons` mirror `disposition_catalog`
 * exactly, down to the `allowed_codes` echo, so two implementations would mean
 * fixing the next bug in it twice.
 *
 * ── What bootstrap advertises is what we render ──────────────────────────────
 * `break_reasons: '[]'` means **"the operator has no opinion"**, not "breaks are
 * off": the API (`resolveBreakReasons`) serves six neutral built-ins
 * in that case, so bootstrap never in practice advertises an empty list. An older
 * description of the empty catalog said every break request is rejected —
 * **that is stale and this component is not built to it.** The disabled state below is kept as a defensive path for a list
 * that arrives empty anyway, because rendering an empty menu or guessing a code
 * are both worse.
 */

/** Turns a silent `400` into a sentence a human can act on. */
export const BREAK_UNCONFIGURED_COPY =
  "Your workspace hasn't set up break reasons yet. Ask your supervisor.";

/** For `unknown_break_reason`. */
export const BREAK_REJECTED_COPY = 'That break reason is no longer available. Pick another.';

export interface BreakMenuProps {
  /** `bootstrap.break_reasons`, re-synced from `allowed_codes` after a rejection. */
  reasons: AgencyBreakReason[];
  /**
   * Label of a break that is already **queued** (`pending_state`). Only changes
   * the trigger's accessible name — the pill is a separate surface.
   */
  queuedReasonLabel?: string | null;
  /** True while a `POST /break` is in flight. */
  busy?: boolean;
  /** Set after `unknown_break_reason`: re-opens the menu on the new codes. */
  rejection?: string | null;
  /** An external reason Break is unavailable, e.g. the campaign has stopped. */
  blockedReason?: string | null;
  onSelect: (code: string) => void;
  /**
   * Lets the page's global `B` shortcut open this menu.
   *
   * A handle rather than an `open` prop, deliberately: the trigger already refuses
   * to open while `busy` or while the reason catalog is empty, and an `open` prop
   * would let a caller bypass both — re-deriving guards the component owns is how
   * the empty-catalog case ships as a menu with nothing in it.
   */
  handleRef?: RefObject<BreakMenuHandle | null>;
}

export interface BreakMenuHandle {
  /** Open the popover and focus its first item, exactly as a click would. */
  open: () => void;
}

export function BreakMenu({
  reasons,
  queuedReasonLabel,
  busy = false,
  rejection = null,
  blockedReason = null,
  onSelect,
  handleRef,
}: BreakMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * **Never render an empty menu and never send a guessed code.** An empty list
   * disables the control with a stated reason instead — a bare greyed button reads
   * as "you lack permission today", which is a support ticket with no resolution.
   */
  const unavailableReason =
    blockedReason ?? (reasons.length === 0 ? BREAK_UNCONFIGURED_COPY : null);
  const unavailable = unavailableReason !== null;

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      // every transient surface returns focus to the control that opened
      // it. A popover that closes and drops focus to `<body>` strands a keyboard
      // agent at the top of the document — on this screen, past the whole contact
      // panel to get back to work.
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  /**
   * The page's `B` shortcut, routed through the same refusal the trigger applies.
   * `unavailable` covers the empty-reason catalog, so a keyboard agent cannot open
   * a menu a pointer agent is correctly denied.
   */
  useImperativeHandle(
    handleRef,
    () => ({
      open: () => {
        if (busy || unavailable) return;
        setActiveIndex(0);
        setOpen(true);
      },
    }),
    [busy, unavailable],
  );

  /**
   * A rejection re-opens the menu on the codes the campaign will actually accept.
   * Not an apology and not a re-bootstrap: one round trip, and the agent picks
   * again.
   */
  useEffect(() => {
    if (rejection === null) return;
    setOpen(true);
    setActiveIndex(0);
  }, [rejection]);

  // Viewport clamping, copied from `HelpTooltip` rather than
  // reinvented: pure-CSS placement clips at the edge of the action bar, which is
  // exactly where this popover lives.
  useEffect(() => {
    if (!open) return undefined;

    const reposition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const tRect = trigger.getBoundingClientRect();
      const pRect = popover.getBoundingClientRect();
      const pad = 8;

      // Prefer above — the action bar sits at the bottom of the console.
      const above = tRect.top - pRect.height - 8 >= pad;
      const top = above ? tRect.top - pRect.height - 8 : tRect.bottom + 8;

      let left = tRect.left;
      if (left + pRect.width > window.innerWidth - pad) {
        left = window.innerWidth - pad - pRect.width;
      }
      if (left < pad) left = pad;

      setPopoverStyle({ position: 'fixed', top: `${top}px`, left: `${left}px` });
    };

    const frame = requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reasons.length]);

  // Focus follows the active item, so the global `:focus-visible` ring is on the
  // thing the arrow keys are moving. Criterion (d) is asserted on a *visible* ring,
  // and `aria-activedescendant` alone would leave the ring on the container.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex, reasons.length]);

  // Dismiss on a click outside. Not `Esc`-only: a pointer user who clicks away has
  // said the same thing.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const select = useCallback(
    (code: string) => {
      if (busy) return;
      onSelect(code);
      // Focus returns to Break, whose accessible name then carries the
      // confirmation ("Break queued — Lunch"). A screen reader announces the
      // focused control's new name, so no third live region is needed.
      close(true);
    },
    [busy, onSelect, close],
  );

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const count = reasons.length;
      if (count === 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % count);
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + count) % count);
          return;
        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          return;
        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          return;
        case 'Escape':
          event.preventDefault();
          close(true);
          return;
        case 'Tab':
          // Focus is trapped while open. Tab moves within the menu
          // rather than escaping it and leaving an open popover behind.
          event.preventDefault();
          setActiveIndex((i) => (event.shiftKey ? (i - 1 + count) % count : (i + 1) % count));
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          {
            const entry = reasons[activeIndex];
            if (entry) select(entry.code);
          }
          return;
        default:
          break;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // Typeahead is scoped to the open menu — it is not a global shortcut — and
      // refuses digits, so `1`–`9` remain the pad's alone.
      const next = typeaheadIndex(reasons, event.key, activeIndex);
      if (next !== null) {
        event.preventDefault();
        setActiveIndex(next);
      }
    },
    [reasons, activeIndex, close, select],
  );

  const onTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (unavailable) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setActiveIndex(event.key === 'ArrowUp' ? Math.max(0, reasons.length - 1) : 0);
        setOpen(true);
      }
    },
    [unavailable, reasons.length],
  );

  itemRefs.current.length = reasons.length;

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        /**
         * Two different unavailabilities, two different mechanisms — and the
         * distinction is the keyboard-order rule:
         *
         *  - **Genuinely unavailable** (no catalog, campaign stopped) uses real
         *    `disabled`, because the tab order requires inactive controls to
         *    be skipped rather than reordered, and this state does not begin while
         *    the control holds focus.
         *  - **Busy** — a request in flight — uses `aria-disabled` and a handler
         *    guard, NEVER `disabled`. Disabling a focused element blurs it in a
         *    real browser and re-enabling does not restore focus, so
         *    `disabled={busy}` would drop a keyboard agent to `<body>` on their
         *    own keypress, for the length of the request.
         */
        disabled={unavailable}
        aria-disabled={busy || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-keyshortcuts="b"
        aria-label={queuedReasonLabel ? `Break queued — ${queuedReasonLabel}` : undefined}
        aria-describedby={unavailable ? 'break-unavailable-reason' : undefined}
        onClick={() => {
          if (busy || unavailable) return;
          setActiveIndex(0);
          setOpen((wasOpen) => !wasOpen);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        Break
        <span className={styles.shortcut} aria-hidden="true">
          B
        </span>
      </button>

      {/* A disabled control always carries a VISIBLE stated reason (house rule). */}
      {unavailable ? (
        <span id="break-unavailable-reason" className={styles.blockedReason}>
          {unavailableReason}
        </span>
      ) : null}

      {open && !unavailable ? (
        <div
          ref={popoverRef}
          className={styles.popover}
          style={popoverStyle}
          role="menu"
          aria-label="Break reasons"
          onKeyDown={onMenuKeyDown}
        >
          {/* The rejection rides inside the menu the agent is already looking at.
              Naming the cause, not the symptom: nothing they did was wrong. */}
          {rejection ? <p className={styles.rejection}>{rejection}</p> : null}
          {reasons.map((reason, index) => (
            <button
              key={reason.code}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className={styles.item}
              data-active={index === activeIndex ? 'true' : undefined}
              // `-1` on the inactive items: the menu owns arrow-key navigation, and
              // leaving them tabbable would let Tab walk out of a trapped popover.
              tabIndex={index === activeIndex ? 0 : -1}
              aria-disabled={busy || undefined}
              onClick={() => select(reason.code)}
            >
              {reason.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
