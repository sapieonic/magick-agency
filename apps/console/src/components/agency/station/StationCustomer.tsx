import { forwardRef } from 'react';
import { Calendar, Clock, IndianRupee, MapPin, MessageSquare, Mic, Phone } from 'lucide-react';
import { NotesField, type NotesFieldProps } from '../NotesField';
import { useDictation } from '../../../hooks/useSpeech';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import type { CustomerCard, CustomerFact, LastCallRow } from '../../../utils/agency/stationCustomer';
import styles from './Station.module.css';

const FACT_ICON: Record<CustomerFact['kind'], typeof Phone | null> = {
  money: IndianRupee,
  date: Calendar,
  last_call: Phone,
  text: null,
};

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
  const title = card.name ?? card.phone;
  if (compact) {
    const first = card.facts.find((f) => f.kind !== 'last_call') ?? null;
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
        <div style={{ minWidth: 0 }}>
          <h2 className={styles.custName} data-testid="customer-name">{title}</h2>
          <div className={styles.custMeta}>
            {card.place ? <span data-testid="customer-place"><MapPin size={16} aria-hidden="true" />{card.place}</span> : null}
            {card.name ? <span data-testid="customer-phone"><Phone size={16} aria-hidden="true" />{card.phone}</span> : null}
          </div>
        </div>
      </div>
      {card.facts.length > 0 || (showLastSaid && card.lastSaid) ? (
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
          {showLastSaid && card.lastSaid ? (
            <div className={`${styles.fact} ${styles.factWide}`} data-testid="customer-last-said">
              <small><MessageSquare size={14} aria-hidden="true" />{STATION_COPY.whatTheySaid}</small>
              <p>“{card.lastSaid}”</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
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
