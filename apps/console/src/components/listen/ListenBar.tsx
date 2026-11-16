import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Volume2, VolumeX } from 'lucide-react';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { elapsedSince } from '../../utils/agencyClock';
import {
  LISTEN_BAR_COPY,
  LISTEN_REFUSAL_COPY,
  LISTEN_REFUSAL_FALLBACK,
  LISTEN_SESSION_NOTICE,
  formatClock,
  listenWhoLabel,
  listenedForLabel,
  muteLabel,
  shortName,
} from '../../utils/listen/listenCopy';
import { liveCallPagePath } from '../../utils/listen/liveCallsTable';
import type { ListenSessionState, ListenTarget } from '../../utils/listen/listenSessionReducer';
import type { ListenPlaybackEngine } from '../../utils/listen/listenPlayback';
import type { AgencyListenLeg } from '../../types/live-calls';
import { useListen } from './ListenProvider';
import styles from './ListenBar.module.css';

/**
 * The listening bar (`docs/listening.md` §9, LS6): docked at the foot of the console shell's
 * content area while a listen is open, across every page of the shell. Who is on the call and
 * how long, a level meter and a mute for each leg, the volume, "Open call", "Stop listening"
 * (Esc while the bar has focus), and, whatever state it is in, the notice that the session is
 * logged. At phone width it is the live dot, the timer and Stop, with the notice under them.
 *
 * Focus: the Listen button gives way to "Connecting…", so focus moves to the bar (where Esc
 * stops), and whenever what held it inside the bar goes; when the bar goes, it returns to the
 * row's Listen if that row is on the page. Focus the supervisor moved elsewhere is left alone.
 *
 * Renders nothing while idle. Reads the shell's listen (`useListen`).
 */
export function ListenBar() {
  const listen = useListen();
  const compact = useMediaQuery('(max-width: 640px)');
  const barRef = useRef<HTMLElement>(null);
  const state = listen?.state ?? null;
  const visible = Boolean(state && state.phase !== 'idle' && state.target);
  const phase = state?.phase ?? 'idle';
  const callId = state?.target?.callId ?? null;
  const lastCallId = useRef<string | null>(null);
  if (visible) lastCallId.current = callId;

  useLayoutEffect(() => {
    if (visible && focusLost()) barRef.current?.focus();
  }, [visible, phase]);

  const wasVisible = useRef(false);
  useLayoutEffect(() => {
    if (wasVisible.current && !visible && focusLost()) listenTrigger(lastCallId.current)?.focus();
    wasVisible.current = visible;
  }, [visible]);

  if (!listen || !state || !visible || !state.target) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (state.phase === 'ended' || state.phase === 'lost') listen.controller.dismiss();
    else listen.stop();
    event.preventDefault();
  };

  return (
    /*
      `ph-no-capture`: the bar names the agent and shows the customer's (masked) number and the
      campaign, and PostHog autocapture records a clicked element's text and attributes. See
      `CustomerSearchBox` for the mechanism and its pins (CH6: the call never reaches analytics).
    */
    <section
      ref={barRef}
      tabIndex={-1}
      className={`${styles.bar} ph-no-capture`}
      aria-label={LISTEN_BAR_COPY.region}
      data-testid="listen-bar"
      data-phase={state.phase}
      data-compact={compact ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      {compact ? <CompactRow state={state} target={state.target} /> : <FullRow state={state} target={state.target} />}
      <Banners state={state} />
      <p className={styles.notice} data-testid="listen-notice">
        <Lock size={12} aria-hidden="true" className={styles.noticeIcon} />
        {LISTEN_SESSION_NOTICE}
      </p>
    </section>
  );
}

/** Nothing has focus: what held it was removed from the page. */
function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/** The row's Listen for `callId` (`LiveCallsTable`), where that row is on this page. */
function listenTrigger(callId: string | null): HTMLElement | null {
  if (!callId) return null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-listen-trigger]')) {
    if (el.dataset.listenTrigger === callId) return el;
  }
  return null;
}

/**
 * The bar's head: what state the listen is in. Its own live region, except when the listen has
 * ended: then the region is the head and the reason together (`region={false}` here).
 */
function Status({ state, region = true }: { state: ListenSessionState; region?: boolean }) {
  let body;
  switch (state.phase) {
    case 'connecting':
      body = (
        <>
          <LoadingSpinner size="sm" decorative />
          {LISTEN_BAR_COPY.connecting}
        </>
      );
      break;
    case 'live':
      body = (
        <>
          <LiveDot live size={8} />
          {LISTEN_BAR_COPY.listening}
        </>
      );
      break;
    case 'reconnecting':
      body = (
        <>
          <LiveDot live={false} size={8} color="var(--warning)" />
          {LISTEN_BAR_COPY.reconnecting}
        </>
      );
      break;
    case 'lost':
      body = LISTEN_BAR_COPY.lost;
      break;
    default:
      body = state.end?.kind === 'call_ended' ? LISTEN_BAR_COPY.callEnded : LISTEN_BAR_COPY.stopped;
  }
  return (
    <span className={styles.status} role={region ? 'status' : undefined} data-testid="listen-status">
      {body}
    </span>
  );
}

/** Time on call, on the server's clock: the pong samples once there are any, the list's until then. */
function CallTimer({ state, target }: { state: ListenSessionState; target: ListenTarget }) {
  useRepaintTick(state.phase !== 'ended');
  const offset = state.clock.sampleCount > 0 ? state.clock.offsetMs : target.clockOffsetMs;
  const elapsed = elapsedSince(target.connectedAt, offset, Date.now());
  return (
    <span className={styles.timer} data-testid="listen-timer">
      {formatClock(elapsed)}
    </span>
  );
}

/**
 * The line under an ended bar's head. A call that ended says who and for how long ("Priya S. with
 * ****4321 · you listened for 02:10") under the "Call ended" head; at phone width, where there is
 * no head, it says "Call ended · you listened for 02:10" itself.
 */
function endedLine(state: ListenSessionState, compact: boolean): string {
  const end = state.end;
  if (!end) return '';
  switch (end.kind) {
    case 'call_ended': {
      if (state.startedAt === null) return LISTEN_BAR_COPY.endedBeforeJoin;
      const who = compact || !state.target ? undefined : listenWhoLabel(state.target.agentName, state.target.customerMasked);
      return listenedForLabel(end.listenedMs, who);
    }
    case 'revoked':
      return LISTEN_BAR_COPY.revoked;
    case 'turned_off':
      return LISTEN_BAR_COPY.turnedOff;
    case 'superseded':
      return LISTEN_BAR_COPY.superseded;
    case 'unverified':
      return LISTEN_BAR_COPY.unverified;
    case 'refused':
      return end.code ? LISTEN_REFUSAL_COPY[end.code] : LISTEN_REFUSAL_FALLBACK.other;
  }
}

function FullRow({ state, target }: { state: ListenSessionState; target: ListenTarget }) {
  const listen = useListen()!;
  const over = state.phase === 'ended';
  // The call's own page; an inbound call has none in the console, so nothing is offered.
  const pagePath = liveCallPagePath(target);
  const openCall = pagePath ? (
    <Link className={styles.link} to={pagePath} data-testid="listen-open-call">
      {LISTEN_BAR_COPY.openCall}
    </Link>
  ) : null;

  if (over) {
    // "Listening stopped because your access could not be checked." says the head's words itself.
    const unverified = state.end?.kind === 'unverified';
    return (
      <div className={styles.row}>
        <div className={styles.who} role="status">
          {unverified ? null : <Status state={state} region={false} />}
          <span className={styles.line} data-testid="listen-ended-line">{endedLine(state, false)}</span>
        </div>
        <div className={styles.controls}>
          {state.end?.kind === 'call_ended' ? openCall : null}
          {unverified ? <RetryButton /> : null}
          <button type="button" className="btn-secondary" onClick={() => listen.controller.dismiss()} data-testid="listen-dismiss">
            {LISTEN_BAR_COPY.dismiss}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.who}>
        <Status state={state} />
        <span className={styles.line}>
          {shortName(target.agentName)} with <span className={styles.mono}>{target.customerMasked}</span>
        </span>
        <span className={styles.line}>
          {target.campaignLabel} · <CallTimer state={state} target={target} />
        </span>
      </div>
      <div className={styles.meters} aria-label={LISTEN_BAR_COPY.levels} role="group">
        <Meter leg="agent" engine={listen.playback.engine} live={state.phase === 'live'} silent={state.agentSilent} />
        <Meter leg="customer" engine={listen.playback.engine} live={state.phase === 'live'} silent={false} />
      </div>
      <div className={styles.controls}>
        <label className={styles.volume}>
          <span className={styles.volumeLabel}>{LISTEN_BAR_COPY.volume}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(listen.playback.volume * 100)}
            onChange={(e) => listen.playback.setVolume(Number(e.target.value) / 100)}
            data-testid="listen-volume"
          />
        </label>
        {openCall}
        <StopOrLost state={state} />
      </div>
    </div>
  );
}

/**
 * "Stop listening" while there is a listen to stop; after "Connection lost" there is none, so Try
 * again and Close (which only puts the bar away) instead of a red Stop that would read as acting
 * on the call.
 */
function StopOrLost({ state, compact = false }: { state: ListenSessionState; compact?: boolean }) {
  const listen = useListen()!;
  if (state.phase === 'lost') {
    return (
      <>
        <RetryButton />
        <button type="button" className="btn-secondary" onClick={() => listen.controller.dismiss()} data-testid="listen-close">
          {LISTEN_BAR_COPY.close}
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="btn-danger"
      aria-label={compact ? LISTEN_BAR_COPY.stop : undefined}
      onClick={listen.stop}
      data-testid="listen-stop"
    >
      {compact ? LISTEN_BAR_COPY.stopShort : LISTEN_BAR_COPY.stop}
    </button>
  );
}

/** Try again: after "Connection lost", and after a listen whose access could not be checked (LS21). */
function RetryButton() {
  const listen = useListen()!;
  return (
    <button type="button" className="btn-primary" onClick={listen.retry} data-testid="listen-retry">
      {LISTEN_BAR_COPY.tryAgain}
    </button>
  );
}

/** Phone width: the live dot, the timer and Stop. */
function CompactRow({ state, target }: { state: ListenSessionState; target: ListenTarget }) {
  const listen = useListen()!;
  if (state.phase === 'ended') {
    return (
      <div className={styles.row}>
        <span className={styles.line} role="status" data-testid="listen-ended-line">{endedLine(state, true)}</span>
        {state.end?.kind === 'unverified' ? <RetryButton /> : null}
        <button type="button" className="btn-secondary" onClick={() => listen.controller.dismiss()} data-testid="listen-dismiss">
          {LISTEN_BAR_COPY.dismiss}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <span className={styles.compactHead}>
        <LiveDot live={state.phase === 'live'} size={8} />
        <span className="sr-only">{state.phase === 'live' ? LISTEN_BAR_COPY.listening : state.phase === 'lost' ? LISTEN_BAR_COPY.lost : LISTEN_BAR_COPY.connecting}</span>
        <CallTimer state={state} target={target} />
      </span>
      <StopOrLost state={state} compact />
    </div>
  );
}

/** A leg's level meter and its mute. The fill is moved by a timer, never by React state. */
function Meter({ leg, engine, live, silent }: { leg: AgencyListenLeg; engine: ListenPlaybackEngine; live: boolean; silent: boolean }) {
  const listen = useListen()!;
  const fillRef = useRef<HTMLSpanElement>(null);
  const muted = listen.playback.muted[leg];

  useEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;
    if (!live) {
      fill.style.width = '0%';
      return;
    }
    const timer = setInterval(() => {
      fill.style.width = `${Math.round(engine.level(leg) * 100)}%`;
    }, 100);
    return () => clearInterval(timer);
  }, [engine, leg, live]);

  const label = leg === 'agent' ? LISTEN_BAR_COPY.agent : LISTEN_BAR_COPY.customer;
  return (
    <div className={styles.meter} data-muted={muted ? 'true' : undefined} data-testid={`listen-meter-${leg}`}>
      <span className={styles.meterLabel}>
        {label}
        {silent ? <span className={styles.meterNote} data-testid="listen-agent-gap">{LISTEN_BAR_COPY.agentSilent}</span> : null}
      </span>
      <span className={styles.track} aria-hidden="true">
        <span ref={fillRef} className={styles.fill} />
      </span>
      <button
        type="button"
        className={styles.mute}
        aria-pressed={muted}
        aria-label={muteLabel(leg, muted)}
        onClick={() => listen.playback.setMuted(leg, !muted)}
        data-testid={`listen-mute-${leg}`}
      >
        {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

function Banners({ state }: { state: ListenSessionState }) {
  const listen = useListen()!;
  return (
    <>
      {state.phase === 'live' && state.soundBlocked ? (
        <div className={styles.banner} role="alert" data-testid="listen-sound-blocked">
          <span>{LISTEN_BAR_COPY.soundBlocked}</span>
          <button type="button" className="btn-secondary" onClick={listen.resumeSound}>
            {LISTEN_BAR_COPY.turnSoundOn}
          </button>
        </div>
      ) : null}
      {state.phase === 'reconnecting' ? (
        <div className={styles.banner} data-tone="warning" data-testid="listen-reconnecting">
          {LISTEN_BAR_COPY.reconnectingDetail}
        </div>
      ) : null}
      {state.phase === 'lost' ? (
        <div className={styles.banner} data-tone="warning" data-testid="listen-lost">
          {LISTEN_BAR_COPY.lostDetail}
        </div>
      ) : null}
    </>
  );
}
