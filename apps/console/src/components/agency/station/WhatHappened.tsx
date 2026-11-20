import { useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { Ban, Calendar, Check, Clock, IndianRupee, MoreHorizontal, Volume2 } from 'lucide-react';
import { AGENCY_PROMISE_MAX_DAYS_AHEAD } from '@magick-agency/contracts/agency';
import { addDays, formatPromiseDay } from '@magick-agency/domain/promise-to-pay';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import { findDisposition, localDay, type DispositionFormState } from '../../../utils/agencyDispositionForm';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { calendarDay, clockTime, halfAmount, rupees, sameDay, weekdayDayMonth } from '../../../utils/agency/stationFormat';
import { NUMBER_KEY_COUNT, type DispositionPadHandle } from '../DispositionPad';
import { outcomeIcon, outcomeTileLayout } from '../../../utils/agency/stationTiles';
import type { AgencyDisposition } from '../../../types/agency';
import { StationTileIcon } from './stationIcons';
import styles from './Station.module.css';

/**
 * 05 What happened? (spec §3 05, §6.2): one picture tile per outcome of this campaign's own list,
 * in the server's order (number keys 1–9 by index, never re-sorted), each with a speaker that reads
 * its label aloud (AS13); then the follow-up the picked outcome needs (pay date and amount, or
 * when to call), inline under the tiles.
 *
 * Picking "Don't call again" (an outcome that stops calls, `suppress`) asks first (05c): the
 * page's confirm, which picks the tile on Yes. The `C` key picks the call-later tile and focuses its
 * first chip, through {@link DispositionPadHandle}, as the old pad did.
 */
export function WhatHappened({
  catalog,
  form,
  onChange,
  enabled,
  now,
  handleRef,
  amountDue,
  comesToMe,
  rejection,
  keysRemapped,
  onNeedsNote,
  readAloud,
  onAskDontCallAgain,
  dontCallAgainOffered,
  shake,
}: {
  catalog: AgencyDisposition[];
  form: DispositionFormState;
  onChange: (next: DispositionFormState) => void;
  enabled: boolean;
  now: () => number;
  handleRef?: RefObject<DispositionPadHandle | null>;
  /** The customer's amount due as uploaded (for Full and Half), or null when not known. */
  amountDue: string | null;
  /** Whether a call-later comes back to this agent (AS8), or null when it is not known. */
  comesToMe: boolean | null;
  rejection: string | null;
  keysRemapped: boolean;
  onNeedsNote: () => void;
  readAloud: { available: boolean; say: (text: string) => void };
  /** The red row's press (no outcome on the list stops calls): the page asks, then marks the number. */
  onAskDontCallAgain: (code: string | null) => void;
  /** The agent may mark a number not to be called (today's `agency.dnc.write`). */
  dontCallAgainOffered: boolean;
  /** Save was pressed before a tile was picked: the tiles shake once (spec §6.1). */
  shake: number;
}) {
  const layout = outcomeTileLayout(catalog);
  const [showAll, setShowAll] = useState(false);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const callWhenRef = useRef<HTMLButtonElement | null>(null);
  const selected = findDisposition(catalog, form.selectedCode);
  const selectedIndex = catalog.findIndex((e) => e.code === form.selectedCode);
  // An outcome behind More that is picked (by its key or a click) keeps the rest open.
  const expanded = showAll || selectedIndex >= layout.shown.length;
  const tiles = expanded ? catalog : layout.shown;

  const select = (entry: AgencyDisposition) => {
    if (!enabled) return;
    if (entry.suppress && form.selectedCode !== entry.code) {
      onAskDontCallAgain(entry.code);
      return;
    }
    onChange({ ...form, selectedCode: entry.code });
    if (entry.requires_note) onNeedsNote();
  };

  useImperativeHandle(
    handleRef,
    () => ({
      selectCallback: () => {
        if (!enabled) return false;
        const entry = catalog.find((option) => option.requires_datetime);
        if (!entry) return false;
        onChange({ ...form, selectedCode: entry.code });
        window.setTimeout(() => callWhenRef.current?.focus(), 0);
        return true;
      },
    }),
    [catalog, enabled, form, onChange],
  );

  return (
    <div className={styles.col}>
      {rejection ? <p className={styles.refusal} role="alert" data-testid="pad-rejection">{rejection}</p> : null}
      {keysRemapped ? <p className={styles.fine} data-testid="pad-keys-remapped">{STATION_COPY.keysMoved}</p> : null}

      <div
        className={styles.picks}
        role="group"
        aria-label={STATION_COPY.happenedTitle}
        data-testid="outcome-tiles"
        data-size={layout.size}
        // Keyed on the press count, so each early Save restarts the shake.
        key={shake}
        data-shake={shake > 0 ? 'true' : undefined}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const at = tileRefs.current.indexOf(document.activeElement as HTMLButtonElement);
          const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
          const next = (Math.max(at, 0) + step + tiles.length) % tiles.length;
          tileRefs.current[next]?.focus();
        }}
      >
        {tiles.map((entry, index) => {
          const icon = outcomeIcon(entry);
          const on = entry.code === form.selectedCode;
          return (
            <div key={entry.code} className={styles.pickWrap}>
              <button
                ref={(node) => {
                  tileRefs.current[index] = node;
                }}
                type="button"
                className={`${styles.pick} ${layout.size === 'small' ? styles.pickSmall : ''}`}
                data-icon={icon}
                data-stop={entry.suppress ? 'true' : undefined}
                data-testid={`outcome-${entry.code}`}
                aria-pressed={on}
                // `aria-disabled`, never `disabled`: a frame that locks the tiles must not throw focus to the page.
                aria-disabled={!enabled || undefined}
                onClick={() => select(entry)}
              >
                {index < NUMBER_KEY_COUNT ? <span className={styles.key} aria-hidden="true">{index + 1}</span> : null}
                <span className={styles.pickIcon} aria-hidden="true"><StationTileIcon icon={icon} size={layout.size === 'small' ? 24 : 32} /></span>
                <b>{entry.label}</b>
                {on ? <span className={styles.tick} aria-hidden="true"><Check size={18} strokeWidth={3} /></span> : null}
              </button>
              {readAloud.available ? (
                <button
                  type="button"
                  className={styles.say}
                  aria-label={STATION_COPY.readAloud(entry.label)}
                  title={STATION_COPY.readAloud(entry.label)}
                  onClick={() => readAloud.say(entry.label)}
                  data-testid={`read-aloud-${entry.code}`}
                >
                  <Volume2 size={20} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
        {!expanded && layout.overflow.length > 0 ? (
          <div className={styles.pickWrap}>
            <button
              type="button"
              className={`${styles.pick} ${styles.pickSmall}`}
              onClick={() => setShowAll(true)}
              data-testid="outcome-more"
            >
              <span className={styles.pickIcon} aria-hidden="true"><MoreHorizontal size={24} /></span>
              <b>{STATION_COPY.moreOutcomes}</b>
              <small>{STATION_COPY.moreOutcomesHint(layout.overflow.length)}</small>
            </button>
          </div>
        ) : null}
      </div>

      {layout.dontCallAgainRow && dontCallAgainOffered ? (
        <button
          type="button"
          className={`${styles.btn} ${styles.dncRow}`}
          onClick={() => onAskDontCallAgain(null)}
          data-testid="dont-call-again-row"
        >
          <Ban size={20} aria-hidden="true" />
          {STATION_COPY.dontCallAgain}
        </button>
      ) : null}

      {selected?.requires_promise ? (
        <PayDateRow
          form={form}
          onChange={onChange}
          enabled={enabled}
          now={now}
          amountDue={amountDue}
          followUpDays={selected.promise_follow_up_days ?? null}
        />
      ) : null}
      {selected?.requires_datetime ? (
        <CallWhenRow form={form} onChange={onChange} enabled={enabled} now={now} comesToMe={comesToMe} firstChipRef={callWhenRef} />
      ) : null}
    </div>
  );
}

function PayDateRow({
  form,
  onChange,
  enabled,
  now,
  amountDue,
  followUpDays,
}: {
  form: DispositionFormState;
  onChange: (next: DispositionFormState) => void;
  enabled: boolean;
  now: () => number;
  amountDue: string | null;
  followUpDays: number | null;
}) {
  const today = localDay(now());
  const chips = [
    { label: STATION_COPY.today, date: formatPromiseDay(today) },
    { label: STATION_COPY.tomorrow, date: formatPromiseDay(addDays(today, 1)) },
    { label: STATION_COPY.inAWeek, date: formatPromiseDay(addDays(today, 7)) },
  ];
  const date = form.promiseDate ?? null;
  const amount = form.promiseAmount ?? '';
  const due = amountDue ? rupees(amountDue) : null;
  const plainDue = amountDue?.trim().replace(/^₹\s*/, '').replace(/,/g, '') ?? null;
  const half = amountDue ? halfAmount(amountDue) : null;
  const followUp = date && followUpDays ? (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    const d = addDays({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, followUpDays);
    return STATION_COPY.willCallAgain(calendarDay(formatPromiseDay(d)));
  })() : null;
  const set = (patch: Partial<DispositionFormState>) => enabled && onChange({ ...form, ...patch });
  return (
    <section className={styles.card} data-testid="promise-row">
      <div className={styles.ask}>
        <span className={styles.askLabel}><Calendar size={20} aria-hidden="true" />{STATION_COPY.payDate}</span>
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={styles.chip}
            aria-pressed={chip.date === date}
            aria-disabled={!enabled || undefined}
            onClick={() => set({ promiseDate: chip.date })}
          >
            {chip.label}
          </button>
        ))}
        <label className={styles.chip}>
          <Calendar size={18} aria-hidden="true" />
          <span className={styles.srOnly}>{STATION_COPY.otherDate}</span>
          <input
            type="date"
            className={styles.chipInput}
            value={date ?? ''}
            min={formatPromiseDay(addDays(today, -1))}
            max={formatPromiseDay(addDays(today, AGENCY_PROMISE_MAX_DAYS_AHEAD + 1))}
            aria-label="Promised payment date"
            disabled={!enabled}
            onChange={(event) => set({ promiseDate: event.target.value || null })}
          />
        </label>
      </div>
      <div className={styles.ask}>
        <span className={styles.askLabel}><IndianRupee size={20} aria-hidden="true" />{STATION_COPY.amount}</span>
        <label className={styles.money}>
          <span aria-hidden="true">₹</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={due ? due.replace('₹', '') : '0'}
            aria-label="Promised amount"
            autoComplete="off"
            disabled={!enabled}
            onChange={(event) => set({ promiseAmount: event.target.value })}
          />
        </label>
        {due && plainDue ? (
          <button type="button" className={styles.chip} aria-pressed={amount.trim() === plainDue} onClick={() => set({ promiseAmount: plainDue })}>
            {STATION_COPY.full} · {due}
          </button>
        ) : null}
        {half ? (
          <button type="button" className={styles.chip} aria-pressed={amount.trim() === half} onClick={() => set({ promiseAmount: half })}>
            {STATION_COPY.half} · {rupees(half)}
          </button>
        ) : null}
      </div>
      {date ? (
        <p className={`${styles.fine} ${styles.fineStrong}`} data-testid="promise-resolved">
          {STATION_COPY.willPayOn(calendarDay(date), amount.trim() ? rupees(amount) ?? amount : null)}
        </p>
      ) : null}
      {followUp ? <p className={styles.fine} data-testid="promise-follow-up">{followUp}</p> : null}
    </section>
  );
}

/** `YYYY-MM-DDTHH:mm` on the agent's clock: the shape `datetime-local` takes and the form holds. */
function datetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function at(ms: number, dayOffset: number, hour: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function CallWhenRow({
  form,
  onChange,
  enabled,
  now,
  comesToMe,
  firstChipRef,
}: {
  form: DispositionFormState;
  onChange: (next: DispositionFormState) => void;
  enabled: boolean;
  now: () => number;
  comesToMe: boolean | null;
  firstChipRef: RefObject<HTMLButtonElement | null>;
}) {
  // The chips are relative to now, so the row repaints itself while it is on screen.
  useRepaintTick();
  const present = now();
  const evening = at(present, 0, 18);
  const chips = [
    { label: STATION_COPY.inOneHour, at: present + 60 * 60 * 1000 },
    // "Today 6:00 PM" only while there is more than an hour to go.
    ...(evening - present > 60 * 60 * 1000 ? [{ label: STATION_COPY.todayAt(clockTime(evening)), at: evening }] : []),
    { label: STATION_COPY.tomorrowAt(clockTime(at(present, 1, 10))), at: at(present, 1, 10) },
    { label: STATION_COPY.tomorrowAt(clockTime(at(present, 1, 18))), at: at(present, 1, 18) },
  ];
  const value = form.callbackAt;
  const parsed = value ? Date.parse(value) : NaN;
  const when = Number.isFinite(parsed)
    ? `${sameDay(parsed, present) ? 'today' : `on ${weekdayDayMonth(parsed)}`} at ${clockTime(parsed)}`
    : null;
  return (
    <section className={styles.card} data-testid="callback-row">
      <div className={styles.ask}>
        <span className={styles.askLabel}><Clock size={20} aria-hidden="true" />{STATION_COPY.callWhen}</span>
        {chips.map((chip, index) => (
          <button
            key={chip.label}
            ref={index === 0 ? (node) => { (firstChipRef as { current: HTMLButtonElement | null }).current = node; } : undefined}
            type="button"
            className={styles.chip}
            aria-pressed={Number.isFinite(parsed) && datetimeLocal(chip.at) === value}
            aria-disabled={!enabled || undefined}
            onClick={() => enabled && onChange({ ...form, callbackAt: datetimeLocal(chip.at) })}
          >
            {chip.label}
          </button>
        ))}
        <label className={styles.chip}>
          <Clock size={18} aria-hidden="true" />
          <span className={styles.srOnly}>{STATION_COPY.otherTime}</span>
          <input
            type="datetime-local"
            className={styles.chipInput}
            value={value ?? ''}
            aria-label="Callback date and time"
            disabled={!enabled}
            onChange={(event) => onChange({ ...form, callbackAt: event.target.value })}
          />
        </label>
      </div>
      {when ? (
        <p className={`${styles.fine} ${styles.fineStrong}`} data-testid="callback-resolved">
          {comesToMe === false ? STATION_COPY.mayGoToAnother(when) : STATION_COPY.willComeToYou(when)}
        </p>
      ) : null}
    </section>
  );
}
