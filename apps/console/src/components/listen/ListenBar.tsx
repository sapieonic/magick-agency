import { useEffect, useRef, type KeyboardEvent } from 'react';
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
  listenedForLabel,
  muteLabel,
  shortName,
} from '../../utils/listen/listenCopy';
import { liveCallHref } from '../../utils/listen/liveCallsTable';
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
 * Renders nothing while idle. Reads the shell's listen (`useListen`).
 */
export function ListenBar() {
  const listen = useListen();
  const compact = useMediaQuery('(max-width: 640px)');
  if (!listen) return null;
  const { state } = listen;
  if (state.phase === 'idle' || !state.target) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (state.phase === 'ended' || state.phase === 'lost') listen.controller.dismiss();
    else listen.stop();
    event.preventDefault();
  };

  return (
    <section
      className={styles.bar}
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

/** The bar's head: what state the listen is in. */
function Status({ state }: { state: ListenSessionState }) {
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
    <span className={styles.status} role="status" data-testid="listen-status">
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

function endedLine(state: ListenSessionState): string {
  const end = state.end;
  if (!end) return '';
  switch (end.kind) {
    case 'call_ended':
      return listenedForLabel(end.listenedMs);
    case 'revoked':
      return LISTEN_BAR_COPY.revoked;
    case 'superseded':
      return LISTEN_BAR_COPY.superseded;
    case 'refused':
      return end.code ? LISTEN_REFUSAL_COPY[end.code] : LISTEN_REFUSAL_FALLBACK.other;
  }
}

function FullRow({ state, target }: { state: ListenSessionState; target: ListenTarget }) {
  const listen = useListen()!;
  const over = state.phase === 'ended';
  const openCall = (
    <Link className={styles.link} to={liveCallHref(target)} data-testid="listen-open-call">
      {LISTEN_BAR_COPY.openCall}
    </Link>
  );

  if (over) {
    return (
      <div className={styles.row}>
        <div className={styles.who}>
          <Status state={state} />
          <span className={styles.line} data-testid="listen-ended-line">{endedLine(state)}</span>
        </div>
        <div className={styles.controls}>
          {state.end?.kind === 'call_ended' ? openCall : null}
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
      <div className={styles.meters} aria-label="Levels" role="group">
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
        {state.phase === 'lost' ? (
          <button type="button" className="btn-primary" onClick={() => listen.controller.retry()} data-testid="listen-retry">
            {LISTEN_BAR_COPY.tryAgain}
          </button>
        ) : null}
        <button
          type="button"
          className="btn-danger"
          onClick={() => (state.phase === 'lost' ? listen.controller.dismiss() : listen.stop())}
          data-testid="listen-stop"
        >
          {LISTEN_BAR_COPY.stop}
        </button>
      </div>
    </div>
  );
}

/** Phone width: the live dot, the timer and Stop. */
function CompactRow({ state, target }: { state: ListenSessionState; target: ListenTarget }) {
  const listen = useListen()!;
  if (state.phase === 'ended') {
    return (
      <div className={styles.row}>
        <span className={styles.line} data-testid="listen-ended-line">{endedLine(state)}</span>
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
      {state.phase === 'lost' ? (
        <button type="button" className="btn-primary" onClick={() => listen.controller.retry()} data-testid="listen-retry">
          {LISTEN_BAR_COPY.tryAgain}
        </button>
      ) : null}
      <button
        type="button"
        className="btn-danger"
        aria-label={LISTEN_BAR_COPY.stop}
        onClick={() => (state.phase === 'lost' ? listen.controller.dismiss() : listen.stop())}
        data-testid="listen-stop"
      >
        {LISTEN_BAR_COPY.stopShort}
      </button>
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
        {silent ? <span className={styles.meterNote} data-testid="listen-agent-gap">{LISTEN_BAR_COPY.agentReconnecting}</span> : null}
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
    </>
  );
}
