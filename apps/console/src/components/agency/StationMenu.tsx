import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ArrowLeft, ChartNoAxesCombined, LogOut, PhoneOutgoing, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  EXIT_HINT,
  EXIT_LABEL,
  EXIT_WHILE_LEAVING_COPY,
  LEAVE_HINT,
  LEAVE_LABEL,
  STATION_HISTORY_LINKS,
  exitBlockedReason,
  leaveBlockedReason,
} from '../../utils/agencyStationExit';
import type { AgencyAgentState } from '../../types/agency';
import styles from './StationMenu.module.css';

/**
 * The station's `⚙` menu — the two ways out of the console.
 *
 * ── It lives in the HEADER, beside cue settings, and not in the action bar ───
 * The action bar's sequence is fixed (Break → Save → … → Hang up) and is the set
 * of controls that act on the **call in progress**; that order is a
 * tab-order guarantee, so anything inserted there moves a control an agent
 * reaches by muscle memory — and the control next door hangs up on a human
 * being. Leaving the station is not a call action. `CueSettings` sits in the
 * header for the same reason and this follows it exactly.
 *
 * ── Why the two items are refused rather than removed while a call is live ──
 * Geometry is frozen (rule 1 of the page's header comment): every region renders
 * in every state, and inactive controls are refused *in place* so nothing moves
 * between "ringing" and "connected". An item that vanished mid-call would move
 * the one below it under a moving cursor.
 *
 * The refusal is `aria-disabled` plus a handler guard, **never `disabled`** —
 * the same distinction `BreakMenu` draws for its busy state, and for a sharper
 * reason here: this block *begins* while the item may hold focus. A reservation
 * lands, `agentState` goes to `reserved`, and a `disabled` item would blur under
 * a keyboard agent's fingers and drop them to `<body>` at the exact moment a
 * customer starts speaking. Going `available` is the same shape of transition —
 * it can land on a focused Exit — and blocks that item for its own reason.
 *
 * ── The two items block on DIFFERENT sets ───────────────────────────────────
 * Exit is additionally refused in `available`, because it leaves the session in
 * the dialable pool for the length of the API's 45s lease with no console attached.
 * Leave is not, because leaving IS the way out of that pool. The whole argument
 * is at the predicates in `agencyStationExit.ts`; this component asks each item
 * for its own reason rather than sharing one, so the asymmetry cannot be lost by
 * a caller passing a single `blocked` flag.
 */

export interface StationMenuProps {
  /** Authoritative agent state — the only thing that decides whether an exit is refused. */
  agentState: AgencyAgentState;
  /**
   * Whether `Exit station` renders **at all**.
   *
   * True only above the `agent` role: exiting lands on
   * `/agency/campaigns/:id`, a workspace an `agent` (level 5) cannot see, so for
   * them the item would be a control that navigates into a wall. Leaving is
   * everyone's — it is the only thing that frees their live-session slot.
   */
  canExit: boolean;
  /** True while `POST /sessions/:id/leave` is in flight. */
  leaving: boolean;
  onLeave: () => void;
  onExit: () => void;
}

/** Paired 1:1 with `STATION_HISTORY_LINKS` — performance, then calls. */
const HISTORY_ICONS = [ChartNoAxesCombined, PhoneOutgoing] as const;

export function StationMenu({ agentState, canExit, leaving, onLeave, onExit }: StationMenuProps) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /*
    `HTMLElement`, not `HTMLButtonElement`: the history group below is a pair of
    anchors (a new tab, not a handler), and a roving arrow-key menu that skipped
    them would leave two items a keyboard agent can Tab to but not reach the way
    they reach every other item in the same popover.
  */
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const leaveBlocked = leaveBlockedReason(agentState);
  /**
   * A leave in flight refuses Exit as well.
   *
   * Without it the two exits race: the agent lands on the campaign page believing
   * they are out of the pool, while a `POST /leave` that may still fail is in the
   * air behind them. The state-based reason comes first — a live call is the more
   * urgent thing to say.
   */
  const exitBlocked = exitBlockedReason(agentState) ?? (leaving ? EXIT_WHILE_LEAVING_COPY : null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    // every transient surface returns focus to the control that opened
    // it, or a keyboard agent is stranded at the top of the document.
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Focus lands inside the menu on open, not on the container.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
  }, [open]);

  // Viewport clamping by measurement — the trigger sits at the right
  // edge of the header, which is exactly where CSS-only placement clips.
  useEffect(() => {
    if (!open) return undefined;

    const reposition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const tRect = trigger.getBoundingClientRect();
      const pRect = popover.getBoundingClientRect();
      const pad = 8;

      // Prefer below: the trigger is at the top of the console.
      const below = tRect.bottom + pRect.height + 8 <= window.innerHeight - pad;
      const top = below ? tRect.bottom + 8 : Math.max(pad, tRect.top - pRect.height - 8);

      // Right-aligned to the trigger, then clamped — the menu is wider than the
      // icon and would otherwise run off the edge it is anchored to.
      let left = tRect.right - pRect.width;
      if (left + pRect.width > window.innerWidth - pad) left = window.innerWidth - pad - pRect.width;
      if (left < pad) left = pad;

      setPopoverStyle({ position: 'fixed', top: `${top}px`, left: `${left}px` });
    };

    const frame = requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', reposition);
    };
    // Every input that changes the popover's HEIGHT: the item count, and each
    // blocked reason, which appears and disappears mid-shift as calls arrive. A
    // taller popover measured at the old height hangs off the bottom of the
    // viewport, which is where the clamping exists to stop it being.
  }, [open, canExit, leaveBlocked, exitBlocked]);

  // A click away says what `Esc` says.
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

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const items = itemRefs.current.filter((node): node is HTMLElement => node !== null);
      if (items.length === 0) return;
      const current = items.findIndex((node) => node === document.activeElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          items[(current + 1 + items.length) % items.length]?.focus();
          return;
        case 'ArrowUp':
          event.preventDefault();
          items[(current - 1 + items.length) % items.length]?.focus();
          return;
        case 'Escape':
          event.preventDefault();
          close(true);
          return;
        default:
      }
    },
    [close],
  );

  /*
    Leave, optionally Exit, then one per history link. Truncated rather than
    cleared so the refs of the items that are still rendered survive a state
    change that removes one.
  */
  itemRefs.current.length = (canExit ? 2 : 1) + STATION_HISTORY_LINKS.length;
  const historyRefBase = canExit ? 2 : 1;

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        // An icon-only control still needs a name, and "Settings" would collide
        // with the cue settings sitting immediately beside it.
        aria-label="Station options"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Settings size={16} strokeWidth={2} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className={styles.popover}
          style={popoverStyle}
          role="menu"
          aria-label="Station options"
          onKeyDown={onMenuKeyDown}
        >
          <button
            ref={(node) => {
              itemRefs.current[0] = node;
            }}
            type="button"
            role="menuitem"
            className={styles.item}
            data-testid="leave-station"
            aria-disabled={leaveBlocked !== null || leaving || undefined}
            aria-describedby={leaveBlocked ? 'station-leave-blocked' : undefined}
            onClick={() => {
              if (leaveBlocked || leaving) return;
              close(false);
              onLeave();
            }}
          >
            <LogOut size={16} strokeWidth={2} className={styles.itemIcon} aria-hidden="true" />
            <span className={styles.itemBody}>
              <span className={styles.itemLabel}>{leaving ? 'Leaving…' : LEAVE_LABEL}</span>
              <span className={styles.itemHint}>{LEAVE_HINT}</span>
            </span>
          </button>
          {/* The stated reason is VISIBLE, not a `title` — a disabled control
              whose reason only exists in a tooltip is a control with no reason
              for anyone who is not holding a mouse. */}
          {leaveBlocked ? (
            <p id="station-leave-blocked" className={styles.blockedReason}>
              {leaveBlocked}
            </p>
          ) : null}

          {canExit ? (
            <>
              <button
                ref={(node) => {
                  itemRefs.current[1] = node;
                }}
                type="button"
                role="menuitem"
                className={styles.item}
                data-testid="exit-station"
                aria-disabled={exitBlocked !== null || undefined}
                aria-describedby={exitBlocked ? 'station-exit-blocked' : undefined}
                onClick={() => {
                  if (exitBlocked) return;
                  close(false);
                  onExit();
                }}
              >
                <ArrowLeft size={16} strokeWidth={2} className={styles.itemIcon} aria-hidden="true" />
                <span className={styles.itemBody}>
                  <span className={styles.itemLabel}>{EXIT_LABEL}</span>
                  <span className={styles.itemHint}>{EXIT_HINT}</span>
                </span>
              </button>
              {exitBlocked ? (
                <p id="station-exit-blocked" className={styles.blockedReason}>
                  {exitBlocked}
                </p>
              ) : null}
            </>
          ) : null}

          {/*
            The agent's own numbers, in a NEW TAB. Separated by a rule because
            these are not ways out of the station — they are the one thing in
            this menu that leaves the session, the socket and the agent's place
            in the queue exactly as they are. See `STATION_HISTORY_LINKS`.
          */}
          <hr className={styles.divider} />
          {STATION_HISTORY_LINKS.map((link, index) => {
            const Icon = HISTORY_ICONS[index] ?? PhoneOutgoing;
            return (
            <Link
              key={link.to}
              ref={(node) => {
                itemRefs.current[historyRefBase + index] = node;
              }}
              role="menuitem"
              className={styles.item}
              data-testid={`station-history-${index}`}
              to={link.to}
              target="_blank"
              /*
                `noopener` is the half that matters here: without it the opened
                tab holds a live `window.opener` on the document running a call
                and can navigate it out from under the agent.
              */
              rel="noopener noreferrer"
              // Closed, but focus is NOT returned to the trigger: the reader's
              // attention has gone to the new tab, and yanking focus back would
              // fight the browser for it.
              onClick={() => close(false)}
            >
              <Icon size={16} strokeWidth={2} className={styles.itemIcon} aria-hidden="true" />
              <span className={styles.itemBody}>
                <span className={styles.itemLabel}>{link.label}</span>
                <span className={styles.itemHint}>{link.hint}</span>
              </span>
            </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
