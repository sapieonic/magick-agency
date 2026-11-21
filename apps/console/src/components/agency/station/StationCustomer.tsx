import { forwardRef, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Calendar, Clock, IndianRupee, MapPin, MessageSquare, Mic, Phone } from 'lucide-react';
import { NotesField, type NotesFieldProps } from '../NotesField';
import { useDictation } from '../../../hooks/useSpeech';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { fitFontSize, type CustomerCard, type CustomerFact, type LastCallRow } from '../../../utils/agency/stationCustomer';
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
 * when its width changes, and the size is set in one write (no read-write loop).
 */
function FitValue({ text, className, testId, empty }: { text: string; className: string; testId: string; empty?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = -1;
    const fit = (next: number) => {
      if (next === width) return;
      width = next;
      el.style.fontSize = '';
      const size = fitFontSize(parseFloat(getComputedStyle(el).fontSize), el.clientWidth, el.scrollWidth);
      if (size !== null) el.style.fontSize = `${size}px`;
    };
    fit(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => fit(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return <span ref={ref} className={className} data-testid={testId} data-empty={empty ? 'true' : undefined}>{text}</span>;
}

/**
 * One chosen fact (AS19): its name, its value on one line, and a hover card with the name, the
 * whole value and "From column: X" while it is pointed at or focused (tiles are focusable, so the
 * keyboard reaches it). Escape closes it. The card shows the value as the tile writes it, so a
 * masked phone never shows its digits there.
 */
function FactTile({ fact, open, onOpen, onClose }: { fact: CustomerFact; open: boolean; onOpen: (via: 'hover' | 'focus') => void; onClose: (via: 'hover' | 'focus' | 'escape') => void }) {
  const popId = useId();
  const tileRef = useRef<HTMLDivElement>(null);
  const [alignEnd, setAlignEnd] = useState(false);
  const show = (via: 'hover' | 'focus') => {
    const rect = tileRef.current?.getBoundingClientRect();
    // Open towards the inside of the window: a tile near the right edge aligns the card to its end.
    setAlignEnd(rect ? rect.left + 300 > window.innerWidth - 16 && rect.right > 300 : false);
    onOpen(via);
  };
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
      aria-label={`${fact.label}: ${fact.value}`}
      aria-describedby={open ? popId : undefined}
      data-highlight={fact.highlight ? 'true' : undefined}
      data-span={fact.span}
      data-testid="customer-fact"
      onPointerEnter={() => show('hover')}
      onPointerLeave={() => onClose('hover')}
      onFocus={() => show('focus')}
      onBlur={() => onClose('focus')}
      onKeyDown={onKeyDown}
    >
      <small data-testid="customer-fact-label">{fact.label}</small>
      {fact.fit ? (
        <FitValue text={fact.value} className={valueClass} testId="customer-fact-value" empty={fact.empty} />
      ) : (
        <span className={valueClass} data-testid="customer-fact-value" data-empty={fact.empty ? 'true' : undefined}>{fact.value}</span>
      )}
      {open ? (
        <div id={popId} role="tooltip" className={styles.factPop} data-align={alignEnd ? 'end' : undefined} data-testid="fact-hover-card">
          <small>{fact.label}</small>
          <b>{fact.value}</b>
          {fact.column ? <span>{STATION_COPY.factFromColumn(fact.column)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The campaign's chosen facts (AS19), four across, one hover card open at a time. */
function ChosenFacts({ facts }: { facts: CustomerFact[] }) {
  const [open, setOpen] = useState<{ key: string; via: 'hover' | 'focus' } | null>(null);
  return (
    <div className={styles.chosenFacts} data-testid="customer-facts">
      {facts.map((fact) => (
        <FactTile
          key={fact.key}
          fact={fact}
          open={open?.key === fact.key}
          onOpen={(via) => setOpen({ key: fact.key, via })}
          onClose={(via) =>
            setOpen((current) => (current?.key !== fact.key || (via !== 'escape' && current.via !== via) ? current : null))
          }
        />
      ))}
    </div>
  );
}

/**
 * The customer card (spec 03/04): who, where, the number, up to three big facts and what they
 * said last time. It does not move between Call coming and On call.
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
    return (
      <section className={styles.card} aria-label={title} data-testid="customer-card">
        {card.redial ? (
          <span className={styles.tag} data-testid="redial-tag">{STATION_COPY.callAgainTag(card.redial.number, card.redial.of)}</span>
        ) : null}
        <div className={styles.cust} style={{ marginBottom: 0 }}>
          {card.initials ? <span className={`${styles.avatar} ${styles.avatarSm}`} aria-hidden="true">{card.initials}</span> : null}
          <div>
            <h2 className={`${styles.custName} ${styles.custNameSm}`} data-testid="customer-name">{title}</h2>
            <div className={styles.custMeta}>
              {first ? <span>{first.label}: <b>{first.value}</b></span> : <span>{card.phone}</span>}
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
