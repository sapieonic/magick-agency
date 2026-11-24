import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleHelp,
  EllipsisVertical,
  LayoutGrid,
  List,
  LogOut,
  Moon,
  Sun,
  Users,
  Volume2,
} from 'lucide-react';
import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import { useRenderAt } from '../../../hooks/useRenderAt';
import type { StationHelp } from '../../../pages/agency/station/useStationHelp';
import type { HelpWhere } from '../../../utils/agency/helpTelemetry';
import { STATION_COPY, helpAskedLabel } from '../../../utils/agency/stationCopy';
import type { MoreItem, StationView } from '../../../utils/agency/stationView';
import { BAND_ICONS } from './stationIcons';
import styles from './Station.module.css';

/** What the frame reads off a view: the screen's name, its colour, icon and words. */
export type FrameView = Pick<StationView, 'tone' | 'icon' | 'title' | 'subtitle'> & { screen: string };

/**
 * The station's frame (AS1, spec §3 "Every screen"): the top bar (who, today's work, Need help, ⋮
 * More), the full-width band in the state's colour, banners under it, the screen's body, and the
 * footer whose main button is always bottom right. Screens fill the slots; the frame never moves.
 */
export function StationFrame({
  view,
  agentName,
  workName,
  brandMark,
  needHelp,
  menu,
  bandSide,
  bandSubtitle,
  banners,
  children,
  footLeft,
  footRight,
  footHint,
  bodyClassName,
  bodyRef,
  connectFlash,
  testId,
}: {
  /** The band: one of the twelve screens, or a screen the station shows around them (a join refusal, the soft phone). */
  view: FrameView;
  agentName: string;
  workName: string | null;
  brandMark: string;
  needHelp?: ReactNode;
  menu?: ReactNode;
  bandSide?: ReactNode;
  /** Replaces the view's subtitle (On call names the customer; 08's lateness counts). */
  bandSubtitle?: ReactNode | null;
  banners?: ReactNode;
  children: ReactNode;
  footLeft?: ReactNode;
  footRight?: ReactNode;
  footHint?: ReactNode;
  bodyClassName?: string;
  bodyRef?: RefObject<HTMLElement>;
  connectFlash?: boolean;
  testId?: string;
}) {
  const Icon = BAND_ICONS[view.icon];
  const subtitle = bandSubtitle !== undefined ? bandSubtitle : view.subtitle;
  return (
    <div
      className={styles.shell}
      data-screen={view.screen}
      data-tone={view.tone}
      data-connect-flash={connectFlash ? 'true' : undefined}
      data-testid={testId ?? 'station'}
    >
      <header className={styles.top}>
        <span className={styles.brand} aria-hidden="true">{brandMark}</span>
        <span className={styles.who}>
          <b data-testid="station-agent">{agentName}</b>
          {workName ? <span data-testid="station-work">{workName}</span> : null}
        </span>
        <span className={styles.topRight}>
          {needHelp}
          {menu}
          {/* The station has no sidebar: the release version ends its one bar, as plain text. */}
          <span className={styles.version}><AppVersion version={__APP_VERSION__} variant="inline" /></span>
        </span>
      </header>

      {/*
        The band is the screen's one polite status region: its title and subtitle change with the
        state, and that is the announcement. Clocks inside it are `aria-hidden`.
      */}
      <section
        className={styles.band}
        data-tone={view.tone}
        data-testid="station-band"
        role="status"
        aria-live="polite"
        aria-labelledby="station-band-title"
      >
        <span className={styles.bandIcon} aria-hidden="true">
          <Icon size={34} strokeWidth={2} />
        </span>
        <span className={styles.bandText}>
          <h1 id="station-band-title" data-testid="band-title">{view.title}</h1>
          {subtitle ? <p data-testid="band-subtitle">{subtitle}</p> : null}
        </span>
        {bandSide}
      </section>

      <main
        ref={bodyRef}
        className={`${styles.body} ${bodyClassName ?? ''}`}
        tabIndex={-1}
        aria-labelledby="station-band-title"
        data-testid="station-body"
      >
        {children}
      </main>

      {footLeft || footRight || footHint ? (
        <StationFoot>
          <div className={styles.footLeft}>
            {footHint ? <span className={styles.footHint}>{footHint}</span> : null}
            {footLeft}
          </div>
          {footRight ? <div className={styles.footRight}>{footRight}</div> : null}
        </StationFoot>
      ) : null}

      {/*
        Banners sit directly under the band on screen (spec §3) but AFTER the screen's own controls
        in the document, so in Tab order too: a message reaches the agent without ever standing
        between them and the call's buttons (LF25). CSS `order` places them.
      */}
      {banners ? <div className={styles.banners} data-testid="station-banners">{banners}</div> : null}

    </div>
  );
}

/** A banner under the band (spec §3): one line, an icon, in a state's colours or the message colours. */
/** 02b's "The last call did not connect": how long it stays (or until the next call). */
export const LAST_CALL_BANNER_MS = 6_000;

/**
 * A banner that goes by itself {@link LAST_CALL_BANNER_MS} after `at` (02b's "The last call did not
 * connect"; the page keys it on the release, so the next one starts afresh). One timer to its end
 * and none after: its words never change, so nothing repaints while it shows.
 */
export function TimedBanner({ at, icon, testId, children }: { at: number | null; icon: ReactNode; testId: string; children: ReactNode }) {
  const endsAt = at === null ? null : at + LAST_CALL_BANNER_MS;
  const shown = endsAt !== null && Date.now() < endsAt;
  useRenderAt(shown ? endsAt + 1 : null);
  if (!shown) return null;
  return <StationBanner tone="quiet" icon={icon} role="status" testId={testId}>{children}</StationBanner>;
}

export function StationBanner({
  tone,
  icon,
  message = false,
  children,
  action,
  testId,
  role,
}: {
  tone?: StationView['tone'];
  icon: ReactNode;
  message?: boolean;
  children: ReactNode;
  action?: ReactNode;
  testId?: string;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      className={`${styles.banner} ${message ? styles.bannerMsg : ''}`}
      data-tone={tone}
      data-testid={testId}
      role={role}
    >
      <span className={styles.bannerIcon} aria-hidden="true">{icon}</span>
      <div className={styles.bannerText} data-testid={testId ? `${testId}-body` : undefined}>{children}</div>
      {action}
    </div>
  );
}

/**
 * Need help, top right (AS5). One button for the request's life: it raises, and once a request
 * is open the same button cancels it, reading "Help asked · 0:42". What it says once a supervisor
 * answers, or the request lapses, is a banner (the page's).
 */
export function NeedHelpButton({
  help,
  raisedAt,
  nowMs,
  where,
}: {
  help: StationHelp;
  raisedAt: string | null;
  nowMs: () => number;
  /** Where this button is, for Need help's telemetry (LF39); absent, the campaign's own screen. */
  where?: HelpWhere;
}) {
  useRepaintTick(help.open);
  const raised = raisedAt ? Date.parse(raisedAt) : NaN;
  const label = help.busy
    ? help.open
      ? STATION_COPY.helpCancelling
      : STATION_COPY.helpAsking
    : help.open
      ? helpAskedLabel(Number.isFinite(raised) ? nowMs() - raised : 0)
      : STATION_COPY.needHelp;
  return (
    <button
      type="button"
      className={styles.help}
      data-open={help.open ? 'true' : undefined}
      aria-disabled={help.busy || undefined}
      title={help.open ? STATION_COPY.helpCancelHint : STATION_COPY.helpRaiseHint}
      onClick={() => help.press(where)}
      data-testid="need-help-button"
    >
      <CircleHelp size={20} aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Need help in the top bar of a screen with no campaign view model: an inbound call, the soft phone
 * on the station and the soft phone page (AS5). Shown while floor assist is on and the socket is
 * open, when a request is open (cancelling is always offered), when raising is offered in every
 * state (BE-9), or on a call (`where.onCall`) once an older server narrowed it back to calls.
 */
export function SideNeedHelpButton({
  help,
  connected,
  where,
  raisedAt,
  nowMs,
}: {
  help: StationHelp;
  connected: boolean;
  where: HelpWhere;
  raisedAt: string | null;
  nowMs: () => number;
}) {
  if (!help.offered || !connected || !(help.open || help.everywhere || where.onCall)) return null;
  return <NeedHelpButton help={help} raisedAt={raisedAt} nowMs={nowMs} where={where} />;
}

const MENU_ICONS: Record<MoreItem, ReactNode> = {
  my_customers: <Users size={20} aria-hidden="true" />,
  dial_myself: <LayoutGrid size={20} aria-hidden="true" />,
  my_calls: <List size={20} aria-hidden="true" />,
  sound: <Volume2 size={20} aria-hidden="true" />,
  theme: null,
  finish: <LogOut size={20} aria-hidden="true" />,
};

/**
 * ⋮ More (spec §3 top bar). Items that cannot be used now are not in it (the view model's list).
 * A menu button: Escape or a click away closes it and focus returns to ⋮.
 */
export function MoreMenu({
  items,
  theme,
  onSelect,
  myCallsTo,
}: {
  items: MoreItem[];
  theme: 'light' | 'dark';
  onSelect: (item: MoreItem) => void;
  myCallsTo: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    // Focus the first item, so the keyboard lands inside.
    const first = wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  // An item that goes away under an open menu (a call arrives) closes it.
  const key = items.join(',');
  useEffect(() => setOpen(false), [key]);

  if (items.length === 0) return null;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  const choose = (item: MoreItem) => {
    // Back to ⋮, so a dialog the item opens (Sound) returns focus there when it closes.
    close(true);
    onSelect(item);
  };

  const label = (item: MoreItem): string => {
    switch (item) {
      case 'my_customers': return STATION_COPY.menuMyCustomers;
      case 'dial_myself': return STATION_COPY.menuDialMyself;
      case 'my_calls': return STATION_COPY.menuMyCalls;
      case 'sound': return STATION_COPY.menuSound;
      case 'theme': return theme === 'dark' ? STATION_COPY.menuLightScreen : STATION_COPY.menuDarkScreen;
      case 'finish': return STATION_COPY.menuFinish;
    }
  };

  return (
    <span
      ref={wrapRef}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const nodes = Array.from(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
          const at = nodes.indexOf(document.activeElement as HTMLElement);
          const next = event.key === 'ArrowDown' ? (at + 1) % nodes.length : (at - 1 + nodes.length) % nodes.length;
          nodes[next]?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.moreButton}
        aria-label={STATION_COPY.more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        data-testid="station-more"
      >
        <EllipsisVertical size={22} aria-hidden="true" />
      </button>
      {open ? (
        <div id={menuId} className={styles.menu} role="menu" aria-label={STATION_COPY.more} data-testid="station-more-menu">
          {items.map((item) => (
            <Fragment key={item}>
              {item === 'finish' ? <hr className={styles.menuRule} /> : null}
              {item === 'my_calls' ? (
                <Link
                  role="menuitem"
                  className={styles.menuItem}
                  to={myCallsTo}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => close(true)}
                  data-testid="station-menu-my_calls"
                >
                  {MENU_ICONS[item]}
                  {label(item)}
                </Link>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  data-stop={item === 'finish' ? 'true' : undefined}
                  onClick={() => choose(item)}
                  data-testid={`station-menu-${item}`}
                >
                  {item === 'theme' ? (theme === 'dark' ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />) : MENU_ICONS[item]}
                  {label(item)}
                </button>
              )}
            </Fragment>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The footer (AS1: its main button is always bottom right). Where it stays at the bottom of the
 * window (AS20, `.foot` in `Station.module.css`), the page's `scroll-padding-bottom` follows its
 * height, so the browser never scrolls a focused field to where the footer covers it (WCAG 2.4.11).
 */
function StationFoot({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const foot = ref.current;
    if (!foot || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const fit = () => {
      root.style.scrollPaddingBottom = getComputedStyle(foot).position === 'sticky' ? `${foot.offsetHeight}px` : '';
    };
    const observer = new ResizeObserver(fit);
    observer.observe(foot);
    window.addEventListener('resize', fit);
    fit();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      root.style.scrollPaddingBottom = '';
    };
  }, []);
  return (
    <footer ref={ref} className={styles.foot} data-station-foot>
      {children}
    </footer>
  );
}
