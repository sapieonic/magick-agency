import { useState } from 'react';
import { Check, ListOrdered, MessageSquareQuote, Volume2 } from 'lucide-react';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import type { FilledLine } from '../../../utils/agency/stationScript';
import styles from './Station.module.css';

/**
 * The campaign's script on the call screens (BE-8, spec 03 and 04). The lines arrive filled
 * (`stationScript.ts`); a key this customer has no value for reads "<label> not given" in the
 * muted style (AS19), and Read aloud skips it. The opening line has a speaker that reads it aloud where the browser can
 * speak (AS13), until the call connects; What to say, on the call, has none.
 */
export interface ReadAloud {
  available: boolean;
  say: (text: string) => void;
}

/** A filled line: its text, and each "not given" run in the muted style. */
function ScriptLineText({ line }: { line: FilledLine }) {
  return (
    <>
      {line.pieces.map((piece, i) =>
        piece.kind === 'missing' ? (
          <span key={i} className={styles.scriptMissing} data-testid="script-missing">{piece.text}</span>
        ) : (
          piece.text
        ),
      )}
    </>
  );
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
export function ScriptOpeningCard({ line, readAloud }: { line: FilledLine; readAloud: ReadAloud }) {
  return (
    <section className={`${styles.card} ${styles.scriptOpening}`} data-tone="coming" data-testid="script-opening">
      <h2 className={styles.cardTitle}>
        <MessageSquareQuote size={20} aria-hidden="true" />
        <span className={styles.grow}>{STATION_COPY.firstSayThis}</span>
        <SpeakButton line={line.spoken} label={STATION_COPY.readLineAloud} readAloud={readAloud} testId="script-opening-say" />
      </h2>
      <p className={styles.scriptOpeningLine} data-testid="script-opening-line">“<ScriptLineText line={line} />”</p>
    </section>
  );
}

/**
 * "What to say" (04): every step, numbered. A click on a step marks it, and every step before
 * it, done; the current step is the first not done. Done steps are struck through with a tick.
 * Where the agent is lives on this screen only (the server keeps none): the page mounts it keyed
 * on the call, so it starts afresh with each call.
 */
/*
  No speaker on the steps: they are on screen only while the customer is on the line, and the
  device's speech can reach the customer through the agent's microphone (Read aloud is kept to
  before the call connects and to What happened?).
*/
export function ScriptStepsCard({ steps }: { steps: readonly FilledLine[] }) {
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
                <span className={styles.scriptText}><ScriptLineText line={line} /></span>
              </button>
            </li>
          );
        })}
      </ol>
      {count >= steps.length ? <p className={styles.fine} data-testid="script-all-done"><Check size={16} aria-hidden="true" />{STATION_COPY.allStepsDone}</p> : null}
    </section>
  );
}
