import { useId, type RefObject } from 'react';
import { Delete, Phone } from 'lucide-react';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { formatDuration } from '../../utils/agencyClock';
import {
  DIAL_BLOCK_COPY,
  DIAL_KEYS,
  DIAL_KEY_LETTERS,
  formatDialNumber,
} from '../../utils/softphone/phoneInput';
import type { ServerClock } from '../../hooks/useServerClock';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import styles from './SoftphoneView.module.css';

/** VoiceLink cannot cancel a ringing call (SP3): what the agent must know before they hang up. */
export const RINGING_HANGUP_WARNING =
  'VoiceLink cannot stop a ringing call. If you hang up now, the customer’s phone keeps ringing for a while, and if they answer they hear nothing. Hang up only when you must.';

const STATUS_LABEL = {
  dialing: 'Dialing',
  ringing: 'Ringing',
  on_call: 'Connected',
  outcome: 'Ended',
} as const;

/**
 * Column 1: the number, the keypad, the caller ID and Call — or, once a call is
 * placed, who is being called and from where.
 *
 * The number field is a real `<input>` so typing, selecting and the browser's
 * own paste all work, and the keypad writes into the same value; a keypress on
 * the page outside any field reaches it too (`useSoftphoneShortcuts`). A paste
 * anywhere is cleaned (`normalisePastedNumber`) — `+91 98204 61733`,
 * `098204 61733` and `0091…` all land as the number the agent meant.
 */
export function DialPad({
  sp,
  clock,
  numberInputRef,
  callButtonRef,
}: {
  sp: SoftphoneState;
  clock: ServerClock;
  numberInputRef: RefObject<HTMLInputElement>;
  callButtonRef: RefObject<HTMLButtonElement>;
}) {
  const reasonId = useId();
  const callerSelectId = useId();
  const phase = sp.phase;
  const call = sp.call;
  const countryCode = sp.bootstrap?.default_country_code ?? '+91';

  if (phase !== 'ready' && call) {
    return (
      <div className={styles.column}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Dial</h2>
          <span className={`${styles.pill} ${styles.pillInfo}`}>Soft phone</span>
        </div>
        <div>
          <p className={styles.callingTo} data-testid="calling-to">
            {formatDialNumber(call.destination_e164)}
          </p>
          <p className={styles.callingFrom}>From {formatDialNumber(call.caller_id)}</p>
        </div>
        <div className={styles.factGrid}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Status</span>
            <span className={styles.factValue} data-testid="call-status">
              {STATUS_LABEL[phase]}
            </span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Talk time</span>
            <span className={`${styles.factValue} ${styles.mono}`}>
              <TalkTime bridgedAt={call.bridged_at} endedSeconds={phase === 'outcome' ? call.talk_seconds : null} clock={clock} />
            </span>
          </div>
        </div>
        {phase === 'ringing' ? (
          <p className={styles.ringWarning} data-testid="ringing-warning">
            {RINGING_HANGUP_WARNING}
          </p>
        ) : null}
        {phase === 'outcome' ? (
          <p className={styles.hint} data-testid="outcome-closes">
            Dialing is blocked until this call has an outcome.
            {call.outcome_due_at ? <OutcomeCloses dueAt={call.outcome_due_at} clock={clock} /> : null}
          </p>
        ) : null}
      </div>
    );
  }

  const blockCopy = sp.number.length > 0 && sp.dialBlock ? DIAL_BLOCK_COPY[sp.dialBlock] : null;
  const reason = sp.dialUnavailableReason ?? blockCopy;
  const disabled = !sp.setupEditable;

  return (
    <form
      className={styles.column}
      aria-label="Dial a number"
      onSubmit={(event) => {
        event.preventDefault();
        sp.dial();
      }}
    >
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Dial</h2>
        <p className={styles.hint}>Paste works too</p>
      </div>

      <div className={styles.numberBox}>
        {sp.number.startsWith('+') ? null : (
          <span className={styles.countryCode} title="Numbers without a country code are read in this one">
            {countryCode}
          </span>
        )}
        <input
          ref={numberInputRef}
          className={styles.numberInput}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          aria-label="Phone number"
          aria-describedby={reason ? reasonId : undefined}
          placeholder="Number to call"
          value={sp.number}
          disabled={disabled}
          onChange={(event) => sp.setNumber(event.target.value)}
          data-testid="dial-number"
        />
        <button
          type="button"
          className={styles.backspace}
          aria-label="Delete last digit"
          onClick={sp.backspace}
          disabled={disabled || sp.number.length === 0}
        >
          <Delete size={18} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.keypad} role="group" aria-label="Keypad">
        {DIAL_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={styles.key}
            aria-label={DIAL_KEY_LETTERS[key] && key !== '0' ? `${key} ${DIAL_KEY_LETTERS[key]}` : key}
            disabled={disabled}
            onClick={() => sp.pressKey(key)}
            data-testid={`dial-key-${key}`}
          >
            <span className={styles.keyDigit} aria-hidden="true">
              {key}
            </span>
            <span className={styles.keyLetters} aria-hidden="true">
              {DIAL_KEY_LETTERS[key]}
            </span>
          </button>
        ))}
      </div>

      <div className={styles.field}>
        <label htmlFor={callerSelectId}>Call from</label>
        <select
          id={callerSelectId}
          value={sp.callerId ?? ''}
          disabled={disabled || sp.callerIdOptions.length === 0}
          onChange={(event) => sp.setCallerId(event.target.value)}
          data-testid="caller-id"
        >
          {sp.callerIdOptions.length === 0 ? <option value="">No numbers available</option> : null}
          {sp.callerIdOptions.map((id) => (
            <option key={id} value={id}>
              {formatDialNumber(id)}
            </option>
          ))}
        </select>
        <p className={styles.hint}>
          {sp.campaign ? `From ${sp.campaign.campaign_name}’s caller IDs` : 'From the numbers assigned to your account'}
        </p>
      </div>

      <button
        ref={callButtonRef}
        type="submit"
        className={`${styles.callButton} btn-ember`}
        disabled={!sp.canDial}
        aria-describedby={reason ? reasonId : undefined}
        aria-keyshortcuts="Enter"
        data-testid="dial-call"
      >
        <Phone size={18} aria-hidden="true" />
        {sp.placing ? 'Calling…' : 'Call'}
        <span className={styles.kbd} aria-hidden="true">
          Enter
        </span>
      </button>

      {sp.dialError ? (
        <p className={styles.inlineError} role="alert" data-testid="dial-error">
          {sp.dialError}
        </p>
      ) : reason ? (
        <p id={reasonId} className={styles.blockReason} data-testid="dial-reason">
          {reason}
        </p>
      ) : null}
    </form>
  );
}

/** Live from `bridged_at` while the call is up; the stored total once it has ended. */
/**
 * When an unsaved outcome lapses: the reaper closes the call with no outcome at
 * `outcome_due_at` (`docs/softphone.md` §4.1 step 8). Outside the rail, which is
 * the polite live region, so the ticking digits are read when the agent goes to
 * them and are never announced every second.
 */
function OutcomeCloses({ dueAt, clock }: { dueAt: string; clock: ServerClock }) {
  useRepaintTick();
  const ms = clock.until(dueAt);
  if (ms === null) return null;
  return (
    <>
      {' '}
      {ms > 0 ? (
        <>
          Without one, it closes in <span className={styles.mono}>{formatDuration(ms)}</span>.
        </>
      ) : (
        'Closing with no outcome…'
      )}
    </>
  );
}

function TalkTime({
  bridgedAt,
  endedSeconds,
  clock,
}: {
  bridgedAt: string | null;
  endedSeconds: number | null;
  clock: ServerClock;
}) {
  const ticking = endedSeconds === null && bridgedAt !== null;
  useRepaintTick(ticking);
  if (endedSeconds !== null) return <>{formatDuration(endedSeconds * 1000)}</>;
  if (!bridgedAt) return <>—</>;
  const ms = clock.since(bridgedAt);
  return <>{ms === null ? '—' : formatDuration(ms)}</>;
}
