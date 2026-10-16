import { useEffect, type RefObject } from 'react';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { isTextEntryTarget } from '../../../utils/keyboardTarget';
import { dispositionForNumberKey } from '../../../utils/agencyDispositionForm';
import { trackAgencyShortcutUsed, trackAgencyDispositionBlocked } from '../../../analytics/events';
import type { AgencyConsoleState } from '../useAgencyConsole';
import type { BreakMenuHandle } from '../../../components/agency/BreakMenu';
import type { DispositionPadHandle } from '../../../components/agency/DispositionPad';
import type { DncControlHandle } from '../../../components/agency/DncControl';
import type { AgencyAgentState, AgencySessionBootstrap } from '../../../types/agency';

/** The controls the shortcuts drive, each by the handle of the component that owns it. */
export interface StationShortcutTargets {
  breakMenuRef: RefObject<BreakMenuHandle | null>;
  notesRef: RefObject<HTMLTextAreaElement>;
  fieldFilterRef: RefObject<HTMLInputElement>;
  padRef: RefObject<DispositionPadHandle | null>;
  dncRef: RefObject<DncControlHandle | null>;
}

/**
 * The global keyboard map.
 *
 * **All single-key shortcuts are suppressed while focus is inside a text
 * input**, except `Esc` and `Ctrl`/`Cmd`+`Enter` — otherwise typing a note
 * containing the letter "b" opens the break menu mid-sentence. `E`,`E` is not
 * here: `HoldToConfirmButton` owns it, so the hold fill and the double-tap
 * share one state machine rather than two that can disagree — and `C` and `D`
 * follow the same rule, each delegating to the component that owns the state.
 *
 * **Bound once, for the life of the page.** It reads the console through a
 * latest-value ref rather than closing over it: `cons` is a fresh object every
 * render, so a handler depending on it was removed and re-added on every render
 * — four times a second while the root repainted on a clock, and still on every
 * frame since.
 */
export function useStationShortcuts(
  state: { agentState: AgencyAgentState; cons: AgencyConsoleState; bootstrap: AgencySessionBootstrap | null },
  { breakMenuRef, notesRef, fieldFilterRef, padRef, dncRef }: StationShortcutTargets,
): void {
  const shortcutStateRef = useLatestRef(state);
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const { agentState, cons, bootstrap } = shortcutStateRef.current;
      // Analytics only: every shortcut reports against the station's campaign.
      const stationCampaign = bootstrap?.campaign_id ?? '';
      const shortcutUsed = (
        key: Parameters<typeof trackAgencyShortcutUsed>[0]['key'],
        accepted: boolean,
      ) => trackAgencyShortcutUsed({ campaign_id: stationCampaign, key, accepted });
      // `isTextEntryTarget` carries the whole argument for why an `<input>` is
      // not automatically a text field — and the hang-up's `E`,`E` reads it too.
      const inTextField = isTextEntryTarget(event.target);

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        const accepted = cons.padEnabled && cons.block === null;
        if (accepted) {
          event.preventDefault();
          cons.submit();
        }
        shortcutUsed('ctrl_enter', accepted);
        if (!accepted && cons.block !== null) {
          trackAgencyDispositionBlocked({
            campaign_id: stationCampaign,
            reason: cons.block,
            method: 'ctrl_enter',
          });
        }
        return;
      }
      if (inTextField || event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();

      if (key === 'a') {
        // One key for two verbs, because the rail says which one is on offer and
        // the agent is never asked to remember.
        if (agentState === 'offline') {
          event.preventDefault();
          cons.goAvailable('shortcut');
          shortcutUsed('a', true);
        } else if (agentState === 'break') {
          event.preventDefault();
          cons.endBreak('shortcut');
          shortcutUsed('a', true);
        } else {
          shortcutUsed('a', false);
        }
        return;
      }

      if (key === 'b') {
        event.preventDefault();
        breakMenuRef.current?.open();
        shortcutUsed('b', true);
        return;
      }

      if (key === 'n') {
        if (cons.notesEnabled) {
          event.preventDefault();
          notesRef.current?.focus();
        }
        shortcutUsed('n', cons.notesEnabled);
        return;
      }

      if (key === '/') {
        // Focuses the filter input; nothing to enable/disable here — the
        // box is present at every density and in every call state, so there is
        // no "refuses" branch the way `C` and `N` have one. Once focus lands
        // inside the input, `inTextField` above is what stops this branch from
        // firing again — the second `/` types a literal slash rather than
        // re-focusing a field that already has focus.
        event.preventDefault();
        fieldFilterRef.current?.focus();
        shortcutUsed('slash', true);
        return;
      }

      if (key === 'c') {
        // Selects the callback code AND moves focus to the time row — both
        // halves, in the pad, so the key and a pointer share one state machine.
        // The pad refuses when it is disabled or the campaign has no
        // datetime-bearing code, and `preventDefault` follows the refusal so an
        // unhandled `c` still reaches the page as an ordinary key.
        //
        // Captured once into a local rather than called a second time for the
        // tracking call below — `selectCallback()` acts (it moves focus), so a
        // second invocation would be a second action, not a re-read.
        const selected = padRef.current?.selectCallback();
        if (selected) event.preventDefault();
        shortcutUsed('c', Boolean(selected));
        return;
      }

      if (key === 'd') {
        // Opens the confirmation, never the request. exists for the
        // customer who says "take me off your list" and hangs up in three
        // seconds — reachable in one key, still impossible to do by accident.
        event.preventDefault();
        dncRef.current?.open();
        shortcutUsed('d', true);
        return;
      }

      if (key >= '1' && key <= '9') {
        if (!cons.padEnabled) return;
        // Index-based against the catalog **in the order the API delivered it**. A
        // client-side sort would silently remap every agent's muscle memory the
        // moment an admin renames a code.
        const entry = dispositionForNumberKey(cons.catalog, key);
        // Emitted once the pad is at least enabled — a digit typed while the pad
        // is closed isn't a shortcut attempt on this surface.
        shortcutUsed('digit', Boolean(entry));
        if (!entry) return;
        event.preventDefault();
        // Analytics-only: this code was picked by a number key, not a click.
        cons.noteCodeSelectionMethod('number_key');
        cons.setForm({ ...cons.form, selectedCode: entry.code });
        if (entry.requires_note) notesRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [shortcutStateRef]);
}
