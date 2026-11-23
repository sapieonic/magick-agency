import { useImperativeHandle, useRef, type RefObject } from 'react';
import { Ban, Banknote, Calendar, Clock } from 'lucide-react';
import { AGENCY_PROMISE_MAX_DAYS_AHEAD } from '@magick-agency/contracts/agency';
import { addDays, formatPromiseDay } from '@magick-agency/domain/promise-to-pay';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import { findDisposition, localDay, type DispositionFormState, type DispositionPadHandle } from '../../../utils/agencyDispositionForm';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { calendarDay, clockTime, halfAmount, promisedAmount, sameDay, weekdayDayMonth } from '../../../utils/agency/stationFormat';
import { outcomeTileLayout } from '../../../utils/agency/stationTiles';
import type { AgencyDisposition } from '../../../types/agency';
import { OutcomeTileGrid } from './OutcomeTileGrid';
import styles from './Station.module.css';

/**
 * 05 What happened? (spec §3 05, §6.2): one picture tile per outcome of this campaign's own list,
 * in the server's order (number keys 1–9 by index, never re-sorted), each with a speaker that reads
 * its label aloud (AS13), drawn by `OutcomeTileGrid`; then the follow-up the picked outcome needs
 * (pay date and amount, or when to call), inline under the tiles.
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
  callLaterLine,
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
  /**
   * The line under Call when? where nothing calls the customer back by itself (a side view's call
   * that no list is waiting on); absent, the line follows `comesToMe` (AS8).
   */
  callLaterLine?: (when: string) => string;
}) {
  const layout = outcomeTileLayout(catalog);
  const callWhenRef = useRef<HTMLButtonElement | null>(null);
  const selected = findDisposition(catalog, form.selectedCode);

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

      <OutcomeTileGrid
        catalog={catalog}
        selectedCode={form.selectedCode}
        onSelect={select}
        enabled={enabled}
        readAloud={readAloud}
        shake={shake}
      />

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
        <CallWhenRow form={form} onChange={onChange} enabled={enabled} now={now} comesToMe={comesToMe} firstChipRef={callWhenRef} line={callLaterLine} />
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
  // Full and Half propose what the customer promises: a promised amount carries no ₹ (PT5).
  const due = amountDue ? promisedAmount(amountDue) : null;
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
            disabled={!enabled}
            onChange={(event) => set({ promiseDate: event.target.value || null })}
          />
        </label>
      </div>
      <div className={styles.ask}>
        <span className={styles.askLabel}><Banknote size={20} aria-hidden="true" data-icon="amount" />{STATION_COPY.amount}</span>
        {/* A promised amount carries no currency (PT5): no ₹ here, as in the app. */}
        <label className={styles.money} data-testid="promise-amount">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={due ?? '0'}
            aria-label={STATION_COPY.amount}
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
            {STATION_COPY.half} · {promisedAmount(half)}
          </button>
        ) : null}
      </div>
      {date ? (
        <p className={`${styles.fine} ${styles.fineStrong}`} data-testid="promise-resolved">
          {STATION_COPY.willPayOn(calendarDay(date), amount.trim() ? promisedAmount(amount) ?? amount : null)}
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
  line,
}: {
  form: DispositionFormState;
  onChange: (next: DispositionFormState) => void;
  enabled: boolean;
  now: () => number;
  comesToMe: boolean | null;
  firstChipRef: RefObject<HTMLButtonElement | null>;
  line?: (when: string) => string;
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
            disabled={!enabled}
            onChange={(event) => onChange({ ...form, callbackAt: event.target.value })}
          />
        </label>
      </div>
      {when ? (
        <p className={`${styles.fine} ${styles.fineStrong}`} data-testid="callback-resolved">
          {line ? line(when) : comesToMe === false ? STATION_COPY.mayGoToAnother(when) : STATION_COPY.willComeToYou(when)}
        </p>
      ) : null}
    </section>
  );
}
