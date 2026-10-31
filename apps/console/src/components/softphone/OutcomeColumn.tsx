import type { RefObject } from 'react';
import { RotateCcw } from 'lucide-react';
import { DispositionPad, type DispositionPadHandle } from '../agency/DispositionPad';
import { NotesField } from '../agency/NotesField';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { catalogForCall, loggedToLabel, manualCallOutcome, recentCallWhen } from '../../utils/softphone/callLabels';
import { SOFTPHONE_NOTES_DISABLED_COPY, type SoftphoneState } from '../../hooks/useSoftphone';
import type { ServerClock } from '../../hooks/useServerClock';
import styles from './SoftphoneView.module.css';

/** A callback on a call the campaign is not waiting on stays on the call; nothing re-dials it. */
export const SOFTPHONE_CALLBACK_NOTE =
  'The callback time is saved on this call. It isn’t added to a campaign’s queue, so make a note to call back yourself.';

/**
 * Column 3: recent calls while idle; the outcome pad and the notes once a call
 * is placed.
 *
 * The pad is the station's `DispositionPad`, unchanged in its rules — keys 1–9 in
 * the order the catalog arrives, a required note focuses the notes, a callback
 * code asks for a time — fed the tagged campaign's catalog or the soft phone's
 * own. It opens when the customer answers; Save opens when the call ends.
 */
export function OutcomeColumn({
  sp,
  clock,
  padRef,
  notesRef,
}: {
  sp: SoftphoneState;
  clock: ServerClock;
  padRef: RefObject<DispositionPadHandle | null>;
  notesRef: RefObject<HTMLTextAreaElement>;
}) {
  if (sp.phase === 'ready' || !sp.call) return <RecentCalls sp={sp} />;

  const contactClaimed = Boolean(sp.call.contact?.claimed);
  return (
    <>
      <DispositionPad
        catalog={sp.catalog}
        form={sp.form}
        onChange={(next) => sp.setForm(next, 'click')}
        enabled={sp.padEnabled}
        disabledReason={sp.padDisabledReason}
        rejection={sp.padRejection}
        now={clock.now}
        onNeedsNote={() => notesRef.current?.focus()}
        handleRef={padRef}
        hint={sp.call.tag ? `From ${sp.call.tag.campaign_name}’s outcome list` : 'From the soft phone’s outcome list'}
        callbackNote={contactClaimed ? undefined : SOFTPHONE_CALLBACK_NOTE}
      />
      <NotesField
        ref={notesRef}
        value={sp.notes}
        onAgentEdit={sp.setNotes}
        status={sp.notesStatus}
        enabled={sp.notesEnabled}
        disabledReason={sp.notesEnabled ? null : SOFTPHONE_NOTES_DISABLED_COPY}
        onSubmit={sp.saveOutcome}
      />
    </>
  );
}

function RecentCalls({ sp }: { sp: SoftphoneState }) {
  return (
    <div className={styles.column}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Recent calls</h2>
        <p className={styles.hint}>Yours, newest first</p>
      </div>
      {sp.recentLoading && sp.recent.length === 0 ? (
        <p className={styles.hint}>Loading your recent calls…</p>
      ) : sp.recentError && sp.recent.length === 0 ? (
        <p className={styles.hint} data-testid="recent-error">
          We couldn’t load your recent calls. They’re still in My calls.
        </p>
      ) : sp.recent.length === 0 ? (
        <p className={styles.hint} data-testid="recent-empty">
          Calls you make from the soft phone appear here, ready to redial.
        </p>
      ) : (
        <ul className={styles.recentList} aria-label="Recent calls">
          {sp.recent.map((call) => {
            const outcome = manualCallOutcome(call, catalogForCall(call, sp.bootstrap));
            const when = recentCallWhen(new Date(call.created_at));
            const number = formatDialNumber(call.destination_e164);
            return (
              <li key={call.id} className={styles.recentRow} data-testid={`recent-${call.id}`}>
                <span className={styles.recentText}>
                  <span className={styles.recentNumber}>{number}</span>
                  <span className={styles.recentMeta}>
                    {outcome.text} · {loggedToLabel(call)} · {when}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.redial}
                  onClick={() => sp.redial(call)}
                  disabled={!sp.setupEditable}
                  aria-label={`Redial ${number}`}
                  title="Puts the number in the dial pad. Press Call to dial."
                >
                  <RotateCcw size={15} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
