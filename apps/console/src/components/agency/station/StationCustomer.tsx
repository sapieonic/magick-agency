import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Calendar, ChevronDown, ChevronUp, Clock, IndianRupee, ListPlus, MapPin, MessageSquare, Mic, Phone } from 'lucide-react';
import { NotesField, type NotesFieldProps } from '../NotesField';
import { useDictation } from '../../../hooks/useSpeech';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import {
  FACT_POP_MIN_WIDTH,
  factPopPlacement,
  fitFontSize,
  MORE_DETAILS_GESTURE_GAP_MS,
  MORE_DETAILS_PAUSE_MS,
  MORE_DETAILS_STEP,
  nextMoreShown,
  type CustomerCard,
  type CustomerFact,
  type LastCallRow,
  type MoreDetail,
} from '../../../utils/agency/stationCustomer';
import styles from './Station.module.css';

const FACT_ICON: Record<CustomerFact['kind'], typeof Phone | null> = {
  money: IndianRupee,
  date: Calendar,
  last_call: Phone,
  text: null,
  number: null,
  phone: null,
  yes_no: null,
};

/**
 * A number, amount, date or phone that shrinks to fit its tile (AS19) down to 65 %, then takes
 * the ellipsis. Measured once per value and width: a ResizeObserver on the value re-measures only
 * when its width changes, and the size is set in one write (no read-write loop). It measures again
 * when the page's fonts finish loading (`document.fonts.ready`, and each later `loadingdone`: a
 * value measured in the fallback font is the wrong width) and when the tile is highlighted or
 * stops being (the highlight's value is set larger).
 */
function FitValue({ text, className, testId, highlight }: { text: string; className: string; testId: string; highlight?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = -1;
    let live = true;
    const fit = (next: number) => {
      if (next === width) return;
      width = next;
      el.style.fontSize = '';
      const size = fitFontSize(parseFloat(getComputedStyle(el).fontSize), el.clientWidth, el.scrollWidth);
      if (size !== null) el.style.fontSize = `${size}px`;
    };
    fit(el.clientWidth);
    // Fonts that load after the first measure change the value's width but not the tile's.
    const refit = () => {
      if (!live) return;
      width = -1;
      fit(el.clientWidth);
    };
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    void fonts?.ready?.then(refit);
    fonts?.addEventListener?.('loadingdone', refit);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => fit(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)));
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
      fonts?.removeEventListener?.('loadingdone', refit);
    };
  }, [text, highlight]);
  return <span ref={ref} className={className} data-testid={testId}>{text}</span>;
}

/**
 * One chosen fact (AS19): its name, its value on one line, and a hover card with the name, the
 * whole value and "From column: X" while it is pointed at or focused from the keyboard (tiles are
 * focusable). A mouse click that focuses the tile does not open it (`:focus-visible` semantics,
 * S11): it closes when the pointer leaves. The card stays inside the card's column
 * ({@link factPopPlacement}). Escape closes it (here, and from anywhere through
 * {@link ChosenFacts}). The card shows the value as the tile writes it, so a masked phone never
 * shows its digits there.
 */
function FactTile({ fact, open, onOpen, onClose }: { fact: CustomerFact; open: boolean; onOpen: (via: 'hover' | 'focus') => void; onClose: (via: 'hover' | 'focus' | 'escape') => void }) {
  const popId = useId();
  const tileRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // A focus that a pointer press brings is not a keyboard focus: no card for it.
  const pressed = useRef(false);
  useLayoutEffect(() => {
    const pop = popRef.current;
    const tile = tileRef.current;
    if (!open || !pop || !tile) return;
    pop.style.left = '';
    pop.style.maxWidth = '';
    pop.style.minWidth = '';
    delete pop.dataset['side'];
    const column = (tile.parentElement ?? tile).getBoundingClientRect();
    const at = tile.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    const place = factPopPlacement(at, column, { width: Math.max(box.width, FACT_POP_MIN_WIDTH), height: box.height }, window.innerHeight);
    if (!place) return;
    pop.style.maxWidth = `${place.maxWidth}px`;
    pop.style.minWidth = `${Math.min(FACT_POP_MIN_WIDTH, place.maxWidth)}px`;
    // The width can change with the max: place it again on the width it now has.
    const width = pop.getBoundingClientRect().width || Math.min(box.width, place.maxWidth);
    const final = factPopPlacement(at, column, { width, height: box.height }, window.innerHeight) ?? place;
    pop.style.left = `${final.shift}px`;
    if (final.above) pop.dataset['side'] = 'top';
  }, [open, fact.label, fact.value, fact.column]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      // The card closes, and nothing else on the screen hears this Escape.
      event.stopPropagation();
      event.preventDefault();
      onClose('escape');
    }
  };
  const valueClass = `${styles.tileValue} ${fact.fit ? styles.num : ''}`;
  return (
    <div
      ref={tileRef}
      className={`${styles.tile} ${fact.highlight ? styles.tileHl : ''}`}
      style={{ '--span': fact.span ?? 3 } as CSSProperties}
      tabIndex={0}
      role="group"
      aria-label={fact.empty ? STATION_COPY.factNotGiven(fact.label) : `${fact.label}: ${fact.value}`}
      aria-describedby={open ? popId : undefined}
      data-highlight={fact.highlight ? 'true' : undefined}
      data-span={fact.span}
      data-testid="customer-fact"
      onPointerEnter={() => onOpen('hover')}
      onPointerLeave={() => onClose('hover')}
      onPointerDown={() => {
        // A press on the tile that already has the focus brings no focus event: the blur clears it.
        pressed.current = true;
      }}
      onFocus={() => {
        const byPointer = pressed.current;
        pressed.current = false;
        if (!byPointer) onOpen('focus');
      }}
      onBlur={() => {
        pressed.current = false;
        onClose('focus');
      }}
      onKeyDown={onKeyDown}
    >
      <small data-testid="customer-fact-label">{fact.label}</small>
      {fact.fit ? (
        <FitValue text={fact.value} className={valueClass} testId="customer-fact-value" highlight={fact.highlight} />
      ) : (
        <span className={valueClass} data-testid="customer-fact-value" data-empty={fact.empty ? 'true' : undefined}>{fact.value}</span>
      )}
      {open ? (
        <div ref={popRef} id={popId} role="tooltip" className={styles.factPop} data-testid="fact-hover-card">
          <small>{fact.label}</small>
          <b>{fact.value}</b>
          {fact.column ? <span>{STATION_COPY.factFromColumn(fact.column)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The campaign's chosen facts (AS19), four across, one hover card open at a time: the tile under
 * the pointer, else the focused one. So pointing at B while A has the focus shows B's card, and
 * leaving B brings A's back (none when nothing has the focus). Escape closes it wherever the
 * focus is (a document listener while a card is open); it opens again on the next hover or focus.
 */
function ChosenFacts({ facts }: { facts: CustomerFact[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const open = hovered ?? focused;
  useEffect(() => {
    if (open === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setHovered(null);
      setFocused(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  return (
    <div className={styles.chosenFacts} data-testid="customer-facts">
      {facts.map((fact) => (
        <FactTile
          key={fact.key}
          fact={fact}
          open={open === fact.key}
          onOpen={(via) => (via === 'hover' ? setHovered(fact.key) : setFocused(fact.key))}
          onClose={(via) => {
            const mine = (current: string | null) => (current === fact.key ? null : current);
            if (via === 'hover') setHovered(mine);
            else if (via === 'focus') setFocused(mine);
            else {
              setHovered(null);
              setFocused(null);
            }
          }}
        />
      ))}
    </div>
  );
}

/**
 * How far the last More details was opened, and whether the agent closed it with "Hide", so the
 * card drawn again for the same call (Call coming, then On call: two mounts) opens as far as the
 * agent left it. One entry: the newest.
 */
let rememberedMore: { key: string; shown: number; held: boolean } | null = null;

/** Forgets {@link rememberedMore}: for tests, which draw one call many times. */
export function forgetMoreDetails(): void {
  rememberedMore = null;
}

/**
 * The bottom of the part of the window the agent can see: the top of the station's footer while it
 * is stuck to the bottom of the window, else the window's own bottom.
 */
function visibleBottom(): number {
  const foot = document.querySelector<HTMLElement>('[data-station-foot]');
  if (foot && getComputedStyle(foot).position === 'sticky') {
    return Math.min(window.innerHeight, foot.getBoundingClientRect().top);
  }
  return window.innerHeight;
}

/** True when the element is at least partly in sight (above the stuck footer). */
function onScreen(el: HTMLElement): boolean {
  const box = el.getBoundingClientRect();
  return box.bottom > 0 && box.top < visibleBottom();
}

/** Where a scroll aimed at something else starts: a field, a dialog, a widget that takes arrows. */
const NOT_THE_PAGE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [aria-modal="true"], [role="listbox"], [role="menu"], [role="radiogroup"], [role="slider"], [role="tablist"]';

/**
 * True when a wheel, touch or key starting at `target` moves the page, not something inside it: not
 * in a field, a dialog or an arrow-key widget, and not in an inner box that can still scroll down.
 */
function movesThePage(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(NOT_THE_PAGE)) return false;
  for (let el: Element | null = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return false;
  }
  return true;
}

/** The keys that move the page down. */
const DOWN_KEYS = new Set(['PageDown', 'ArrowDown', 'End', ' ']);

/**
 * More details (AS20): the customer's other columns, under the card. Closed at first, with a count
 * and "Scroll down to see them."; while its end is in sight, each downward gesture aimed at the page
 * (a turn of the wheel or a trackpad swipe, a finger pushing up, Page Down, the down arrow or the
 * space bar) opens {@link MORE_DETAILS_STEP} more rows: one step per gesture (a gesture's wheel
 * events end with a pause of {@link MORE_DETAILS_GESTURE_GAP_MS}) and at most one step every
 * {@link MORE_DETAILS_PAUSE_MS} ms, each new row fading in (no motion under reduced motion). A
 * scroll inside a field, a dialog or an inner box, and a zoom (ctrl and the wheel), open nothing.
 * "Show all" opens them at once and "Hide" closes them until "Show all" again, for the keyboard
 * and the mouse. Values are uploaded text: plain text, wrapped, never markup.
 */
function MoreDetails({ rows, callKey: key }: { rows: MoreDetail[]; callKey: string }) {
  const total = rows.length;
  const remembered = rememberedMore?.key === key ? rememberedMore : null;
  const [shown, setShown] = useState(() => (remembered ? Math.min(remembered.shown, total) : 0));
  const [held, setHeld] = useState(() => remembered?.held ?? false);
  const [from, setFrom] = useState(shown);
  const endRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef(0);
  const lastWheel = useRef(0);
  const listId = useId();

  useEffect(() => {
    rememberedMore = { key, shown, held };
  }, [key, shown, held]);

  useEffect(() => {
    if (shown >= total || held) return;
    const step = () => {
      const end = endRef.current;
      const now = Date.now();
      if (!end || now - lastStep.current < MORE_DETAILS_PAUSE_MS || !onScreen(end)) return;
      lastStep.current = now;
      // This effect runs again on every change of `shown`, so the closure holds the current one.
      setFrom(shown);
      setShown(nextMoreShown(shown, total));
    };
    const onWheel = (event: WheelEvent) => {
      const now = Date.now();
      const newGesture = now - lastWheel.current >= MORE_DETAILS_GESTURE_GAP_MS;
      lastWheel.current = now;
      if (newGesture && event.deltaY > 0 && !event.ctrlKey && movesThePage(event.target)) step();
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = movesThePage(event.target) ? (event.touches[0]?.clientY ?? null) : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y < touchY - 8) {
        touchY = null; // one step per touch
        step();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!DOWN_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) return;
      const target = event.target;
      // A space on a button presses it; it does not scroll.
      if (event.key === ' ' && target instanceof Element && target.closest('button, a, summary, [role="button"]')) return;
      if (movesThePage(target)) step();
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [shown, total, held]);

  const all = shown >= total;
  const toggle = () => {
    setFrom(all ? 0 : shown);
    setShown(all ? 0 : total);
    setHeld(all);
  };
  const state = shown === 0 ? 'closed' : all ? 'open' : 'partial';
  return (
    <div className={styles.more} data-state={state} data-testid="more-details">
      <div className={styles.moreHead}>
        <h3 className={styles.moreTitle}>
          <ListPlus size={18} aria-hidden="true" />
          {STATION_COPY.moreDetails}{' '}
          <span className={styles.moreCount} data-testid="more-details-count">{STATION_COPY.moreDetailsCount(total)}</span>
        </h3>
        <button
          type="button"
          className={styles.moreToggle}
          aria-expanded={shown > 0}
          aria-controls={shown > 0 ? listId : undefined}
          onClick={toggle}
          data-testid="more-details-toggle"
        >
          {all ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          {all ? STATION_COPY.moreDetailsHide : STATION_COPY.moreDetailsShowAll}
        </button>
      </div>
      {shown > 0 ? (
        <dl id={listId} className={styles.moreList}>
          {rows.slice(0, shown).map((row, i) => (
            <div
              key={row.column}
              className={styles.moreRow}
              // A step's rows come in one after another; "Show all" brings the rest in together after
              // the first few, so a long list is never blank for long.
              style={i >= from ? ({ '--more-i': Math.min(i - from, MORE_DETAILS_STEP - 1) } as CSSProperties) : undefined}
              data-new={i >= from ? 'true' : undefined}
              data-testid="more-detail"
            >
              <dt data-testid="more-detail-label">{row.column}</dt>
              <dd className={row.kind === 'text' ? undefined : styles.num} data-testid="more-detail-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {all ? null : (
        <p className={styles.moreHint} data-testid="more-details-hint">
          {shown === 0 ? STATION_COPY.moreDetailsHint : STATION_COPY.moreDetailsShown(shown, total)}
        </p>
      )}
      <div ref={endRef} className={styles.moreEnd} aria-hidden="true" />
    </div>
  );
}

/**
 * The customer card (spec 03/04): who, where, the number, the facts and what they said last time.
 * A campaign that chose its facts (AS19) shows up to four, its chosen ones; a legacy card shows up
 * to three big facts, the last of them Last call when there is one. It does not move between Call
 * coming and On call.
 */
export function CustomerCardView({
  card,
  showLastSaid = true,
  compact = false,
}: {
  card: CustomerCard;
  showLastSaid?: boolean;
  /** What happened?'s small card: name and the first fact only. */
  compact?: boolean;
}) {
  // AS19: with chosen facts a nameless customer is "Customer" and the number sits under it.
  const title = card.name ?? (card.chosen ? STATION_COPY.customer : card.phone);
  if (compact) {
    const first = card.facts.find((f) => f.kind !== 'last_call' && !f.empty) ?? null;
    // S4: "Customer" says nothing on its own, so the line under it starts with the number.
    const numberFirst = card.chosen && card.name === null;
    return (
      <section className={styles.card} aria-label={title} data-testid="customer-card">
        {card.redial ? (
          <span className={styles.tag} data-testid="redial-tag">{STATION_COPY.callAgainTag(card.redial.number, card.redial.of)}</span>
        ) : null}
        <div className={styles.cust} style={{ marginBottom: 0 }}>
          {card.initials ? <span className={`${styles.avatar} ${styles.avatarSm}`} aria-hidden="true">{card.initials}</span> : null}
          <div>
            <h2 className={`${styles.custName} ${styles.custNameSm}`} data-testid="customer-name">{title}</h2>
            <div className={styles.custMeta} data-testid="customer-line">
              {numberFirst || !first ? <span data-testid="customer-phone">{card.phone}</span> : null}
              {first ? <span data-testid="customer-first-fact">{first.label}: <b>{first.value}</b></span> : null}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className={styles.card} aria-label={title} data-testid="customer-card">
      {card.callLaterTag ? <span className={styles.tag} data-testid="call-later-tag"><Clock size={16} aria-hidden="true" />{card.callLaterTag}</span> : null}
      {card.redial ? (
        <span className={styles.tag} data-testid="redial-tag">{STATION_COPY.callAgainTag(card.redial.number, card.redial.of)}</span>
      ) : null}
      <div className={styles.cust}>
        {card.initials ? <span className={styles.avatar} aria-hidden="true">{card.initials}</span> : null}
        {card.chosen ? (
          <div className={styles.custText}>
            <h2 className={styles.custName} data-testid="customer-name">{title}</h2>
            <div className={styles.custMeta}>
              <span data-testid="customer-phone"><Phone size={16} aria-hidden="true" />{card.phone}</span>
              {card.place ? (
                <span className={styles.custPlace} data-testid="customer-place" title={card.place}>
                  <MapPin size={16} aria-hidden="true" style={{ flex: 'none' }} /><span>{card.place}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ minWidth: 0 }}>
            <h2 className={styles.custName} data-testid="customer-name">{title}</h2>
            <div className={styles.custMeta}>
              {card.place ? <span data-testid="customer-place"><MapPin size={16} aria-hidden="true" />{card.place}</span> : null}
              {card.name ? <span data-testid="customer-phone"><Phone size={16} aria-hidden="true" />{card.phone}</span> : null}
            </div>
          </div>
        )}
      </div>
      {card.chosen && card.facts.length > 0 ? <ChosenFacts facts={card.facts} /> : null}
      {card.chosen ? (
        showLastSaid && card.lastSaid ? (
          <div className={styles.facts} style={card.facts.length > 0 ? { marginTop: 12 } : undefined}>
            <LastSaid text={card.lastSaid} />
          </div>
        ) : null
      ) : card.facts.length > 0 || (showLastSaid && card.lastSaid) ? (
        <div className={styles.facts}>
          {card.facts.map((fact) => {
            const Icon = FACT_ICON[fact.kind];
            return (
              <div key={fact.key} className={styles.fact} data-testid="customer-fact">
                <small>{Icon ? <Icon size={14} aria-hidden="true" /> : null}{fact.label}</small>
                {fact.kind === 'text' ? (
                  <span className={styles.factText}>{fact.value}</span>
                ) : (
                  <span className={styles.num}>{fact.value}</span>
                )}
              </div>
            );
          })}
          {showLastSaid && card.lastSaid ? <LastSaid text={card.lastSaid} /> : null}
        </div>
      ) : null}
      {card.more.length > 0 ? <MoreDetails key={card.moreKey} callKey={card.moreKey} rows={card.more} /> : null}
    </section>
  );
}

function LastSaid({ text }: { text: string }) {
  return (
    <div className={`${styles.fact} ${styles.factWide}`} data-testid="customer-last-said">
      <small><MessageSquare size={14} aria-hidden="true" />{STATION_COPY.whatTheySaid}</small>
      <p>“{text}”</p>
    </div>
  );
}

/** 04c's Last calls: date chip, what happened, the note under it. */
export function LastCallsCard({ rows }: { rows: LastCallRow[] }) {
  return (
    <section className={styles.card} data-testid="last-calls">
      <h2 className={styles.cardTitle}><Clock size={20} aria-hidden="true" />{STATION_COPY.lastCalls}</h2>
      {rows.length === 0 ? (
        <p className={styles.fine} style={{ marginTop: 0 }}>{STATION_COPY.noLastCalls}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <li key={row.key} className={styles.lastCall}>
              {row.date ? <time>{row.date}</time> : null}
              <span style={{ marginTop: 0 }}>
                <b>{row.outcome}</b>
                {row.detail ? <span>{row.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The note (spec 04c, 05): today's notes field (autosave, Ctrl+Enter, Esc) and Speak a note
 * (AS13), which appends what the browser heard. Hidden where the browser cannot listen.
 */
export const NoteCard = forwardRef<HTMLTextAreaElement, Omit<NotesFieldProps, 'label' | 'placeholder'> & { needed?: boolean }>(
  function NoteCard({ needed = false, ...field }, ref) {
    const dictation = useDictation((text) => {
      const current = field.value;
      field.onAgentEdit(current.trim() ? `${current.trimEnd()} ${text}` : text);
    });
    const missing = needed && field.value.trim() === '';
    return (
      <section className={`${styles.card} ${styles.noteBox}`} data-needed={missing ? 'true' : undefined} data-testid="note-card">
        <NotesField
          ref={ref}
          {...field}
          label={STATION_COPY.note}
          placeholder={needed ? STATION_COPY.notePlaceholderNeeded : STATION_COPY.notePlaceholder}
          invalid={missing}
        />
        {missing ? <p className={styles.noteNeeded} data-testid="note-needed">{STATION_COPY.noteNeeded}</p> : null}
        {dictation.available && field.enabled ? (
          <button
            type="button"
            className={styles.speak}
            aria-pressed={dictation.listening}
            onClick={dictation.toggle}
            data-testid="speak-note"
          >
            <Mic size={20} aria-hidden="true" />
            {dictation.listening ? STATION_COPY.speakNoteStop : STATION_COPY.speakNote}
          </button>
        ) : null}
        {dictation.listening ? <p className={styles.fine} role="status">{STATION_COPY.speakNoteListening}</p> : null}
      </section>
    );
  },
);
