import { useEffect, type RefObject } from 'react';
import { useLatestRef } from '../../hooks/useLatestRef';
import { isTextEntryTarget } from '../../utils/keyboardTarget';
import { dispositionForNumberKey } from '../../utils/agencyDispositionForm';
import { isDialChar } from '../../utils/softphone/phoneInput';
import type { DispositionPadHandle } from '../agency/DispositionPad';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import type { ServerClock } from '../../hooks/useServerClock';

/**
 * The soft phone's keyboard, on the window, as the station's is.
 *
 * Digits mean two things and the call's state decides which — never both at
 * once. **Ready**: `0`–`9`, `*`, `#` and `+` type into the number, Backspace
 * deletes, Enter calls, and a paste anywhere on the page lands as a cleaned
 * number. **On call / Outcome needed**: `1`–`9` pick an outcome in the catalog's
 * own order (the station's muscle memory), Enter saves once the call has ended.
 * `M` mutes, `N` goes to the notes, `C` picks the callback outcome, `D` opens the
 * Mark DNC confirmation (the station's key; never the mark itself), `Ctrl`/`⌘`+
 * `Enter` saves from anywhere; `E` twice hangs up (the hold button's own key).
 * The letters are only read once a call is placed — in Ready every key that
 * means anything is a dial character, and `D` is not one.
 *
 * Nothing fires while focus is in a text field (the number field types for
 * itself) or a `<select>` (its own type-ahead), or while a dialog is open, and
 * Enter on a focused button is the button's.
 */
export function useSoftphoneShortcuts(
  sp: SoftphoneState,
  clock: ServerClock,
  refs: {
    numberInputRef: RefObject<HTMLInputElement>;
    notesRef: RefObject<HTMLTextAreaElement>;
    padRef: RefObject<DispositionPadHandle | null>;
    /** False while the host has something else on top (a confirm dialog of its own). */
    enabled?: boolean;
  },
): void {
  const stateRef = useLatestRef({ sp, clock, enabled: refs.enabled ?? true });
  const { numberInputRef, notesRef, padRef } = refs;

  useEffect(() => {
    const dialogOpen = () => {
      const { sp } = stateRef.current;
      return sp.overridePrompt !== null || sp.dncConfirmOpen || document.querySelector('[aria-modal="true"]') !== null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const { sp, clock, enabled } = stateRef.current;
      if (!enabled || dialogOpen()) return;
      const inText = isTextEntryTarget(event.target);
      const target = event.target as HTMLElement | null;
      // A focused <select> takes digits and letters as its own type-ahead (a
      // choice field, the caller ID, "Log to"): a key there is never ours too.
      const onSelect = target?.tagName === 'SELECT';
      const onControl = Boolean(target?.closest?.('button, a, select, [role="button"], [role="menuitem"]'));

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        if (sp.call && sp.saveBlockAt(clock.now()) === null) {
          event.preventDefault();
          sp.saveOutcome();
        }
        return;
      }
      if (inText || onSelect || event.ctrlKey || event.metaKey || event.altKey) return;

      if (sp.phase === 'ready') {
        if (!sp.setupEditable) return;
        if (event.key.length === 1 && isDialChar(event.key)) {
          event.preventDefault();
          sp.pressKey(event.key);
          return;
        }
        if (event.key === 'Backspace') {
          event.preventDefault();
          sp.backspace();
          return;
        }
        if (event.key === 'Enter' && !onControl) {
          event.preventDefault();
          sp.dial();
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'm') {
        if (sp.muteEnabled) {
          event.preventDefault();
          sp.toggleMute();
        }
        return;
      }
      if (key === 'n') {
        if (sp.notesEnabled) {
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
        // The same confirmation the button opens, refused where the button is disabled.
        if (sp.dncEnabled && !sp.dncInFlight && sp.dncOutcome === null) {
          event.preventDefault();
          sp.openDnc();
        }
        return;
      }
      if (key >= '1' && key <= '9') {
        if (!sp.padEnabled) return;
        const entry = dispositionForNumberKey(sp.catalog, key);
        if (!entry) return;
        event.preventDefault();
        sp.setForm({ ...sp.form, selectedCode: entry.code }, 'number_key');
        if (entry.requires_note) notesRef.current?.focus();
        return;
      }
      if (event.key === 'Enter' && !onControl && sp.saveBlockAt(clock.now()) === null) {
        event.preventDefault();
        sp.saveOutcome();
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      const { sp, enabled } = stateRef.current;
      if (!enabled || dialogOpen() || sp.phase !== 'ready' || !sp.setupEditable) return;
      // Another text field takes its own paste; the number field's is ours to clean.
      if (isTextEntryTarget(event.target) && event.target !== numberInputRef.current) return;
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      event.preventDefault();
      sp.pasteNumber(text);
      numberInputRef.current?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onPaste);
    };
  }, [stateRef, numberInputRef, notesRef, padRef]);
}
