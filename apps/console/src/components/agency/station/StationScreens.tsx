import { useEffect, useRef, type ReactNode } from 'react';
import {
  Ban,
  Calendar,
  CircleHelp,
  Clock,
  Coffee,
  Ear,
  Headphones,
  IndianRupee,
  LayoutGrid,
  List,
  Mic,
  MonitorSmartphone,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Target,
  Wifi,
  WifiOff,
  Bell,
  Check,
  X,
  TriangleAlert,
} from 'lucide-react';
import { useDialogA11y } from '../../../hooks/useDialogA11y';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import type { ServerClock } from '../../../hooks/useServerClock';
import type { AgencyBreakReason } from '../../../types/agency';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { clockTime, hoursMinutes, runningClock } from '../../../utils/agency/stationFormat';
import { breakIcon } from '../../../utils/agency/stationTiles';
import type { DeviceChecks } from '../../../utils/agency/stationView';
import type { MyCallLaters, MyDay } from '../../../pages/agency/station/useMyDay';
import { StationTileIcon } from './stationIcons';
import styles from './Station.module.css';

/* ───────────────────────────── 01 / 01b Start of day ───────────────────────────── */

type CheckState = 'ok' | 'bad' | 'warn' | 'wait';

function CheckTile({ icon, name, state, word, testId }: { icon: ReactNode; name: string; state: CheckState; word: string; testId: string }) {
  return (
    <div className={styles.check} data-state={state === 'ok' ? undefined : state} data-testid={testId} data-check={state}>
      <span className={styles.checkIcon} aria-hidden="true">{icon}</span>
      <span>
        <b>{name}</b>
        <em>
          {state === 'ok' ? <Check size={16} strokeWidth={3} aria-hidden="true" /> : null}
          {state === 'bad' ? <X size={16} strokeWidth={3} aria-hidden="true" /> : null}
          {state === 'warn' ? <TriangleAlert size={16} aria-hidden="true" /> : null}
          {word}
        </em>
      </span>
    </div>
  );
}

function micWord(mic: DeviceChecks['microphone']): { state: CheckState; word: string } {
  switch (mic) {
    case 'ok': return { state: 'ok', word: STATION_COPY.checkOk };
    case 'checking': return { state: 'wait', word: STATION_COPY.checkChecking };
    case 'blocked': return { state: 'bad', word: STATION_COPY.checkBlocked };
    case 'not_found': return { state: 'bad', word: STATION_COPY.checkNotFound };
    case 'in_use': return { state: 'bad', word: STATION_COPY.checkInUse };
    case 'problem': return { state: 'bad', word: STATION_COPY.checkProblem };
  }
}

/** The three checks (spec 01): headset where the browser can tell, the microphone, the internet. */
export function DeviceCheckTiles({ checks, internet }: { checks: DeviceChecks; internet: 'ok' | 'checking' | 'offline' }) {
  const mic = micWord(checks.microphone);
  return (
    <div className={styles.checks} data-testid="device-checks">
      {checks.headset !== 'unknown' ? (
        <CheckTile
          icon={<Headphones size={24} />}
          name={STATION_COPY.checkHeadset}
          state={checks.headset === 'ok' ? 'ok' : 'warn'}
          word={checks.headset === 'ok' ? STATION_COPY.checkOk : STATION_COPY.checkNoHeadset}
          testId="check-headset"
        />
      ) : null}
      <CheckTile icon={<Mic size={24} />} name={STATION_COPY.checkMicrophone} state={mic.state} word={mic.word} testId="check-microphone" />
      <CheckTile
        icon={internet === 'offline' ? <WifiOff size={24} /> : <Wifi size={24} />}
        name={STATION_COPY.checkInternet}
        state={internet === 'ok' ? 'ok' : internet === 'checking' ? 'wait' : 'bad'}
        word={internet === 'ok' ? STATION_COPY.checkOk : internet === 'checking' ? STATION_COPY.checkChecking : STATION_COPY.checkOffline}
        testId="check-internet"
      />
    </div>
  );
}

export type WorkMode = 'calls_come' | 'dial_myself';

/** 01's body: the checks, today's work, and How will you work? */
export function StartOfDayBody({
  checks,
  internet,
  workName,
  myDay,
  callLaterCount,
  softphoneOffered,
  mode,
  onMode,
}: {
  checks: DeviceChecks;
  internet: 'ok' | 'checking' | 'offline';
  workName: string;
  myDay: MyDay | null;
  /** Today's call-laters, when the list is served (phase 0: assignment campaigns only). */
  callLaterCount: number | null;
  softphoneOffered: boolean;
  mode: WorkMode;
  onMode: (mode: WorkMode) => void;
}) {
  return (
    <section className={`${styles.card} ${styles.cardNarrow}`} data-testid="start-of-day">
      <DeviceCheckTiles checks={checks} internet={internet} />
      {checks.headset === 'missing' ? (
        <p className={styles.fine} data-testid="no-headset">{STATION_COPY.noHeadsetWarning}</p>
      ) : null}
      <div className={styles.infoRow}>
        <div className={styles.info}>
          <small><List size={14} aria-hidden="true" />{STATION_COPY.todaysWork}</small>
          <b data-testid="todays-work">{workName}</b>
        </div>
        {myDay?.target != null ? (
          <div className={styles.info} data-testid="start-target">
            <small><Target size={14} aria-hidden="true" />{STATION_COPY.target}</small>
            <b>{STATION_COPY.targetValue(myDay.target)}</b>
          </div>
        ) : null}
        {callLaterCount !== null ? (
          <div className={styles.info} data-testid="start-call-later">
            <small><Calendar size={14} aria-hidden="true" />{STATION_COPY.callLater}</small>
            <b>{STATION_COPY.callLaterToday(callLaterCount)}</b>
          </div>
        ) : null}
      </div>
      {softphoneOffered ? (
        <>
          <h2 className={styles.subhead} id="work-mode-title"><Phone size={18} aria-hidden="true" />{STATION_COPY.howWillYouWork}</h2>
          <div className={`${styles.picks} ${styles.picks2}`} role="radiogroup" aria-labelledby="work-mode-title" data-testid="work-mode">
            <WorkTile on={mode === 'calls_come'} icon={<PhoneIncoming size={28} />} title={STATION_COPY.workCallsCome} hint={STATION_COPY.workCallsComeHint} onPick={() => onMode('calls_come')} testId="work-calls-come" />
            <WorkTile on={mode === 'dial_myself'} icon={<LayoutGrid size={28} />} title={STATION_COPY.workDialMyself} hint={STATION_COPY.workDialMyselfHint} onPick={() => onMode('dial_myself')} testId="work-dial-myself" />
          </div>
        </>
      ) : null}
    </section>
  );
}

function WorkTile({ on, icon, title, hint, onPick, testId }: { on: boolean; icon: ReactNode; title: string; hint: string; onPick: () => void; testId: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`${styles.pick} ${styles.pickRow}`}
      data-tone={on ? 'ready' : undefined}
      onClick={onPick}
      data-testid={testId}
    >
      <span className={styles.pickIcon} aria-hidden="true">{icon}</span>
      <span className={styles.pickText}>
        <b>{title}</b>
        <small>{hint}</small>
      </span>
      {on ? <span className={styles.tick} aria-hidden="true"><Check size={18} strokeWidth={3} /></span> : null}
    </button>
  );
}

/** The listening notice, kept short, in Start of day's footer (spec 01). */
export function ListenNoticeLine() {
  return (
    <span className={styles.footHint} data-testid="listen-notice-line">
      <Ear size={18} aria-hidden="true" />
      {STATION_COPY.listenNotice}
    </span>
  );
}

/* ───────────────────────────── What to do (01b, 09, 10) ───────────────────────────── */

export function WhatToDo({ steps, aside }: { steps: readonly string[]; aside?: ReactNode }) {
  return (
    <section className={styles.card} data-testid="what-to-do">
      <h2 className={styles.cardTitle}><CircleHelp size={20} aria-hidden="true" />{STATION_COPY.whatToDo}</h2>
      <ol className={styles.steps}>
        {steps.map((step, i) => (
          <li key={step}><i aria-hidden="true">{i + 1}</i>{step}</li>
        ))}
      </ol>
      {aside}
    </section>
  );
}

/** 09's left card: the big "No internet". */
export function NoInternetCard() {
  return (
    <section className={styles.card}>
      <div className={styles.wait}>
        <span className={`${styles.pulse} ${styles.pulseSm}`} data-tone="problem" aria-hidden="true"><WifiOff size={56} /></span>
        <h2>{STATION_COPY.noInternetBody}</h2>
        <p>{STATION_COPY.noInternetHint}</p>
      </div>
    </section>
  );
}

/* ───────────────────────────── 02 / 02c Ready ───────────────────────────── */

export function WaitingCard({
  quiet,
  headline,
  waiting,
  line,
}: {
  /** 02c: the pause sign and "Calls will start again". */
  quiet: boolean;
  headline: string;
  waiting: ReactNode;
  /** "No answer from the last 2 numbers." (late binding), plain text under the pulse. */
  line: string | null;
}) {
  return (
    <section className={styles.card} data-testid={quiet ? 'no-calls' : 'waiting'}>
      <div className={styles.wait}>
        {quiet ? (
          <span className={`${styles.pulse} ${styles.pulseSm}`} aria-hidden="true"><Pause size={56} /></span>
        ) : (
          <span className={styles.pulse} aria-hidden="true"><Phone size={78} /></span>
        )}
        <h2 data-testid="waiting-headline">{headline}</h2>
        {quiet ? <p>{STATION_COPY.noCallsHint}</p> : <p>{waiting}</p>}
        {line ? <p data-testid="dial-activity">{line}</p> : null}
      </div>
    </section>
  );
}

/** My day (spec 02): rows with a bar on the console. A tile whose number is not known is not shown. */
export function MyDayCard({ day }: { day: MyDay }) {
  const rows: ReactNode[] = [];
  if (day.calls !== null) {
    const pct = day.target ? Math.min(100, Math.round((day.calls / day.target) * 100)) : null;
    rows.push(
      <div key="calls" className={styles.stat} data-tone="ready" data-testid="my-day-calls">
        <span className={styles.statIcon} aria-hidden="true"><Phone size={22} /></span>
        <span className={styles.statLabel}>
          {STATION_COPY.callsToday}
          {pct !== null ? <span className={styles.meter} aria-hidden="true" style={{ display: 'block' }}><i style={{ width: `${pct}%` }} /></span> : null}
        </span>
        <span className={styles.num}>{day.calls}{day.target ? <small> / {day.target}</small> : null}</span>
      </div>,
    );
  }
  if (day.talkSeconds !== null) {
    rows.push(
      <div key="talk" className={styles.stat} data-tone="oncall" data-testid="my-day-talk">
        <span className={styles.statIcon} aria-hidden="true"><Clock size={22} /></span>
        <span className={styles.statLabel}>{STATION_COPY.talkTime}</span>
        <span className={styles.num}>{hoursMinutes(day.talkSeconds)}</span>
      </div>,
    );
  }
  // The third tile: Will pay when the campaign records promises, else Numbers dialled (as the app).
  if (day.willPay !== null) {
    rows.push(
      <div key="pay" className={styles.stat} data-tone="ready" data-testid="my-day-will-pay">
        <span className={styles.statIcon} aria-hidden="true"><IndianRupee size={22} /></span>
        <span className={styles.statLabel}>{STATION_COPY.willPay}</span>
        <span className={styles.num}>{day.willPay}</span>
      </div>,
    );
  } else if (day.dialled !== null) {
    rows.push(
      <div key="dialled" className={styles.stat} data-tone="coming" data-testid="my-day-dialled">
        <span className={styles.statIcon} aria-hidden="true"><PhoneOutgoing size={22} /></span>
        <span className={styles.statLabel}>{STATION_COPY.numbersDialled}</span>
        <span className={styles.num}>{day.dialled}</span>
      </div>,
    );
  }
  if (rows.length === 0) return null;
  return (
    <section className={styles.card} data-testid="my-day">
      <h2 className={styles.cardTitle}><Target size={20} aria-hidden="true" />{STATION_COPY.myDay}</h2>
      {rows}
    </section>
  );
}

/** My call-later list (spec 02, 02b): time chip and name; one due within 5 minutes is marked. */
export function CallLaterCard({ list, now }: { list: MyCallLaters; now: () => number }) {
  useRepaintTick(list.rows.length > 0);
  if (list.rows.length === 0) return null;
  const present = now();
  return (
    <section className={styles.card} data-testid="call-later-list">
      <h2 className={styles.cardTitle}><Calendar size={20} aria-hidden="true" />{STATION_COPY.myCallLaterList}</h2>
      <ul className={styles.laterList}>
        {list.rows.slice(0, 5).map((row) => {
          const minutes = Math.ceil((row.dueAt - present) / 60_000);
          const late = row.overdue || minutes < 0;
          const soon = !late && minutes <= 5;
          return (
            <li key={row.id} className={styles.later} data-soon={soon || late ? 'true' : undefined} data-testid="call-later-row">
              <time dateTime={new Date(row.dueAt).toISOString()}>{clockTime(row.dueAt)}</time>
              <span>{row.name ?? STATION_COPY.customer}</span>
              {late ? <small>{STATION_COPY.late}</small> : soon ? <small>{STATION_COPY.callLaterSoon(minutes)}</small> : null}
            </li>
          );
        })}
      </ul>
      <p className={styles.fine}><Bell size={16} aria-hidden="true" />{list.comesToMe ? STATION_COPY.callLaterComesToMe : STATION_COPY.callLaterPool}</p>
    </section>
  );
}

/* ───────────────────────────── 07 / 08 Breaks ───────────────────────────── */

/** 07 / 08's card: the break, its big clock and bar. Its own leaf: it counts, the root does not. */
export function BreakCard({
  label,
  since,
  clock,
  limitMinutes,
  over,
  reason,
}: {
  label: string | null;
  /** The break's reason as the campaign lists it, for its picture (the supervisor's pick, BE-13). */
  reason?: Pick<AgencyBreakReason, 'code' | 'label' | 'icon'> | null;
  since: string | null;
  clock: ServerClock;
  limitMinutes: number | null;
  over: boolean;
}) {
  useRepaintTick(since !== null);
  const elapsedMs = since ? clock.since(since) : null;
  const icon = breakIcon(reason ?? { code: label ?? '', label: label ?? '' });
  const used = elapsedMs ?? 0;
  const pct = limitMinutes ? Math.min(100, (used / (limitMinutes * 60_000)) * 100) : null;
  const leftMs = limitMinutes ? limitMinutes * 60_000 - used : null;
  const longMinutes = Math.floor(used / 60_000);
  return (
    <section className={`${styles.card} ${styles.cardNarrow}`} data-tone={over ? 'over' : 'break'} data-testid="break-card">
      <div className={styles.wait} style={{ minHeight: 0 }}>
        <span className={`${styles.pulse} ${styles.pulseSm}`} aria-hidden="true">{over ? <TriangleAlert size={56} /> : <StationTileIcon icon={icon} size={56} />}</span>
        {label ? <h2>{label}</h2> : null}
        <div className={styles.clock} data-over={over ? 'true' : undefined}>
          <span className={styles.num} data-testid="break-elapsed">{elapsedMs === null ? '—' : runningClock(used)}</span>
          {limitMinutes ? <span>/ {runningClock(limitMinutes * 60_000)}</span> : null}
        </div>
        {pct !== null ? (
          <span className={`${styles.meter} ${styles.meterBig}`} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
        ) : null}
        <p data-testid="break-line">
          {limitMinutes && leftMs !== null
            ? over
              ? STATION_COPY.breakWas(limitMinutes)
              : STATION_COPY.leftOfYour(runningClock(leftMs), limitMinutes)
            : longMinutes >= 30
              ? STATION_COPY.longBreak(longMinutes)
              : null}
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────────── Dialogs ───────────────────────────── */

export function StationDialog({
  open,
  onClose,
  title,
  icon,
  children,
  small = false,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  small?: boolean;
  testId?: string;
}) {
  const { titleId, dialogRef } = useDialogA11y({ open, onClose });
  if (!open) return null;
  return (
    <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${small ? styles.dialogSm : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <h2 id={titleId}>{icon}{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** 06 Which break? One tap starts the break (or books it after the call); keys 1–9, Esc cancels. */
export function WhichBreakDialog({
  open,
  reasons,
  onPick,
  onClose,
  busy,
  rejection,
}: {
  open: boolean;
  reasons: AgencyBreakReason[];
  onPick: (code: string) => void;
  onClose: () => void;
  busy: boolean;
  rejection: string | null;
}) {
  const firstRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key >= '1' && event.key <= '9') {
        const reason = reasons[Number(event.key) - 1];
        if (reason && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onPick(reason.code);
        }
      }
    };
    // Capture: the digits belong to this dialog while it is open, never to the outcome tiles under it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, reasons, busy, onPick]);

  return (
    <StationDialog open={open} onClose={onClose} title={STATION_COPY.whichBreak} icon={<Coffee size={30} aria-hidden="true" />} testId="which-break">
      {reasons.length === 0 ? <p>{STATION_COPY.noBreakReasons}</p> : null}
      <div className={`${styles.picks} ${styles.picks5}`} role="group" aria-label={STATION_COPY.whichBreak}>
        {reasons.map((reason, index) => {
          const icon = breakIcon(reason);
          return (
            <button
              key={reason.code}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              className={`${styles.pick} ${styles.pickBreak}`}
              aria-disabled={busy || undefined}
              onClick={() => !busy && onPick(reason.code)}
              data-testid={`break-${reason.code}`}
            >
              {index < 9 ? <span className={styles.key} aria-hidden="true">{index + 1}</span> : null}
              <span className={styles.pickIcon} aria-hidden="true" data-icon={icon}><StationTileIcon icon={icon} size={30} /></span>
              <b>{reason.label}</b>
              {reason.limit_minutes ? <small>{STATION_COPY.minutes(reason.limit_minutes)}</small> : null}
            </button>
          );
        })}
      </div>
      {rejection ? <p className={styles.refusal} role="alert" data-testid="break-rejection">{rejection}</p> : null}
      <div className={styles.dialogFoot}>
        <button type="button" className={styles.btn} onClick={onClose} data-testid="which-break-cancel">
          {STATION_COPY.cancel}
          <span className={styles.key} aria-hidden="true">Esc</span>
        </button>
      </div>
    </StationDialog>
  );
}

/** 05c Don't call again: the only outcome that asks (spec §6.3). The safe choice is the first. */
export function StopCallingDialog({
  open,
  who,
  busy,
  failure,
  onYes,
  onNo,
  body = STATION_COPY.stopCallingBody,
}: {
  open: boolean;
  who: string | null;
  busy: boolean;
  failure: string | null;
  onYes: () => void;
  onNo: () => void;
  /** How far it reaches, when that is not "this work" (a side view's caller on no list, or any list). */
  body?: string;
}) {
  return (
    <StationDialog open={open} onClose={onNo} title={STATION_COPY.stopCallingTitle} icon={<Ban size={30} aria-hidden="true" />} small testId="stop-calling">
      {who ? <p><b>{who}</b></p> : null}
      <p>{body}</p>
      {failure ? <p className={styles.refusal} role="alert">{failure}</p> : null}
      <div className={styles.dialogFoot}>
        <button type="button" className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`} onClick={onNo} data-testid="stop-calling-no">
          {STATION_COPY.noGoBack}
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnStopOutline}`} aria-disabled={busy || undefined} onClick={() => !busy && onYes()} data-testid="stop-calling-yes">
          {busy ? STATION_COPY.stoppingCalls : STATION_COPY.yesStopCalls}
        </button>
      </div>
    </StationDialog>
  );
}

/* ───────────────────────────── 11 Finish work, 12 Other device ───────────────────────────── */

/** 11's body: My day, the call-later list, and where the ones left today go. */
export function FinishCard({
  myDay,
  callLaters,
  now,
  failure,
}: {
  myDay: MyDay | null;
  callLaters: MyCallLaters | null;
  now: () => number;
  failure: string | null;
}) {
  const first = callLaters?.rows.find((r) => !r.overdue) ?? null;
  const left = callLaters && callLaters.today > 0 && first
    ? STATION_COPY.leftForToday(callLaters.today, clockTime(first.dueAt), callLaters.leftTodayGoesTo)
    : null;
  return (
    <div className={`${styles.col} ${styles.cardNarrow}`} data-testid="finish-card">
      {myDay ? <MyDayCard day={myDay} /> : null}
      {callLaters && callLaters.rows.length > 0 ? <CallLaterCard list={callLaters} now={now} /> : null}
      {left ? <p className={styles.fine} data-testid="finish-left"><Calendar size={16} aria-hidden="true" />{left}</p> : null}
      {failure ? <p className={styles.refusal} role="alert" data-testid="finish-failure">{failure}</p> : null}
    </div>
  );
}

export function OtherDeviceCard({ title, hint }: { title: string; hint: string }) {
  return (
    <section className={`${styles.card} ${styles.cardNarrow}`} data-testid="other-device">
      <div className={styles.wait} style={{ minHeight: 0 }}>
        <span className={`${styles.pulse} ${styles.pulseSm}`} data-tone="quiet" aria-hidden="true"><MonitorSmartphone size={56} /></span>
        <h2>{title}</h2>
        <p>{hint}</p>
      </div>
    </section>
  );
}
