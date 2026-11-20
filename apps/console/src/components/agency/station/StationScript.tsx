import { useState } from 'react';
import { Check, ListOrdered, MessageSquareQuote, Volume2 } from 'lucide-react';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import styles from './Station.module.css';

/**
 * The campaign's script on the call screens (BE-8, spec 03 and 04). The lines arrive filled
 * (`stationScript.ts`); each has a speaker that reads it aloud where the browser can speak (AS13).
 */
export interface ReadAloud {
  available: boolean;
  say: (text: string) => void;
}

function SpeakButton({ line, label, readAloud, testId }: { line: string; label: string; readAloud: ReadAloud; testId: string }) {
  if (!readAloud.available) return null;
  return (
    <button type="button" className={styles.scriptSay} aria-label={label} title={label} onClick={() => readAloud.say(line)} data-testid={testId}>
      <Volume2 size={20} aria-hidden="true" />
    </button>
  );
}

/** "First, say this" (03): the opening line, big, for the call coming through. */
export function ScriptOpeningCard({ line, readAloud }: { line: string; readAloud: ReadAloud }) {
  return (
    <section className={`${styles.card} ${styles.scriptOpening}`} data-tone="coming" data-testid="script-opening">
      <h2 className={styles.cardTitle}>
        <MessageSquareQuote size={20} aria-hidden="true" />
        <span className={styles.grow}>{STATION_COPY.firstSayThis}</span>
        <SpeakButton line={line} label={STATION_COPY.readLineAloud} readAloud={readAloud} testId="script-opening-say" />
      </h2>
      <p className={styles.scriptOpeningLine} data-testid="script-opening-line">“{line}”</p>
    </section>
  );
}

/**
 * "What to say" (04): every step, numbered. A click on a step marks it, and every step before
 * it, done; the current step is the first not done. Done steps are struck through with a tick.
 * Where the agent is lives on this screen only (the server keeps none): the page mounts it keyed
 * on the call, so it starts afresh with each call.
 */
export function ScriptStepsCard({ steps, readAloud }: { steps: readonly string[]; readAloud: ReadAloud }) {
  const [done, setDone] = useState(0);
  const count = Math.min(done, steps.length);
  return (
    <section className={styles.card} data-tone="oncall" data-testid="script-steps">
      <h2 className={styles.cardTitle}>
        <ListOrdered size={20} aria-hidden="true" />
        <span className={styles.grow}>{STATION_COPY.whatToSay}</span>
        <span className={styles.scriptProgress} data-testid="script-progress">{STATION_COPY.stepsDone(count, steps.length)}</span>
      </h2>
      <ol className={styles.scriptSteps}>
        {steps.map((line, i) => {
          const isDone = i < count;
          const current = i === count;
          return (
            <li key={i} className={styles.scriptStep} data-state={isDone ? 'done' : current ? 'current' : 'next'} data-testid="script-step">
              <button
                type="button"
                className={styles.scriptStepButton}
                aria-pressed={isDone}
                aria-current={current ? 'step' : undefined}
                onClick={() => setDone(i + 1)}
              >
                <span className={styles.scriptNumber} aria-hidden="true">{isDone ? <Check size={16} strokeWidth={3} /> : i + 1}</span>
                <span className={styles.scriptText}>{line}</span>
              </button>
              <SpeakButton line={line} label={STATION_COPY.readStepAloud(i + 1)} readAloud={readAloud} testId={`script-step-say-${i + 1}`} />
            </li>
          );
        })}
      </ol>
      {count >= steps.length ? <p className={styles.fine} data-testid="script-all-done"><Check size={16} aria-hidden="true" />{STATION_COPY.allStepsDone}</p> : null}
    </section>
  );
}
