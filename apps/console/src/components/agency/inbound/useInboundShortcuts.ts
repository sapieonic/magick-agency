import { useEffect, type RefObject } from 'react';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { isTextEntryTarget } from '../../../utils/keyboardTarget';
import { dispositionForNumberKey } from '../../../utils/agencyDispositionForm';
import type { DispositionPadHandle } from '../DispositionPad';
import type { InboundCallState } from '../../../hooks/useInboundCall';
import type { ServerClock } from '../../../hooks/useServerClock';

/**
 * The inbound panel's keys: the station's and the soft phone's, for the same controls.
 *
 *  - `1`–`9` pick an outcome (the pad's order), `C` picks the callback, `N` goes to the notes;
 *  - `Enter` saves (`Ctrl`/`⌘`+`Enter` from inside the notes);
 *  - `M` mutes, `D` opens Mark DNC's confirmation;
 *  - `E` twice hangs up: the hold-to-confirm button owns that one (`HoldToConfirmButton`).
 *
 * Nothing fires while a dialog is open, from inside a text field (except `Ctrl+Enter`), or on a
 * focused control that takes the key itself.
 */
export function useInboundShortcuts(
  ib: InboundCallState,
  clock: ServerClock,
  refs: {
    notesRef: RefObject<HTMLTextAreaElement>;
    padRef: RefObject<DispositionPadHandle | null>;
    enabled?: boolean;
  },
): void {
  const stateRef = useLatestRef({ ib, clock, enabled: refs.enabled ?? true });
  const { notesRef, padRef } = refs;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { ib, clock, enabled } = stateRef.current;
      if (!enabled || !ib.call) return;
      if (ib.dncConfirmOpen || document.querySelector('[aria-modal="true"]') !== null) return;
      const target = event.target as HTMLElement | null;
      const inText = isTextEntryTarget(event.target);
      const onSelect = target?.tagName === 'SELECT';
      const onControl = Boolean(target?.closest?.('button, a, select, [role="button"], [role="menuitem"]'));

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        if (ib.saveBlockAt(clock.now()) === null) {
          event.preventDefault();
          ib.saveOutcome();
        }
        return;
      }
      if (inText || onSelect || event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'm') {
        if (ib.muteEnabled) {
          event.preventDefault();
          ib.toggleMute();
        }
        return;
      }
      if (key === 'n') {
        if (ib.notesEnabled) {
          event.preventDefault();
          notesRef.current?.focus();
        }
        return;
      }
      if (key === 'c') {
        if (padRef.current?.selectCallback()) event.preventDefault();
        return;
      }
      if (key === 'd') {
        if (ib.dncEnabled && !ib.dncInFlight && ib.dncOutcome === null) {
          event.preventDefault();
          ib.openDnc();
        }
        return;
      }
      if (key >= '1' && key <= '9') {
        if (!ib.padEnabled) return;
        const entry = dispositionForNumberKey(ib.catalog, key);
        if (!entry) return;
        event.preventDefault();
        ib.setForm({ ...ib.form, selectedCode: entry.code });
        if (entry.requires_note) notesRef.current?.focus();
        return;
      }
      if (event.key === 'Enter' && !onControl && ib.saveBlockAt(clock.now()) === null) {
        event.preventDefault();
        ib.saveOutcome();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stateRef, notesRef, padRef]);
}
