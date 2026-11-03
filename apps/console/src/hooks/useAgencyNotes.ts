import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { saveAttemptNotes } from '../api/agency';
import { trackAgencyNotesSaveFailed } from '../analytics/events';
import {
  notesStatus,
  notesStorageKey,
  sweepStaleNoteKeys,
  type NotesStatus,
} from '../utils/agencyNotes';
import { useLatestRef } from './useLatestRef';
import type { AgencySessionBootstrap } from '../types/agency';

/**
 * The Agent Console's notes field: hydration, the debounced autosave, the local
 * failure buffer and the status line — keyed by attempt throughout.
 *
 * Split out of `useAgencyConsole`, which still owns WHEN notes are accepted (the
 * pad gate) and what the disposition submit does with them.
 */

/** Debounce for the notes autosave. */
export const NOTES_DEBOUNCE_MS = 2000;

export interface AgencyNotesState {
  notes: string;
  onNotesEdit: (value: string) => void;
  statusLine: NotesStatus;
  foreignWrite: boolean;
  /**
   * The notes and the attempt they belong to, as of the latest render — what the
   * disposition submit's stale-response guard and its payload read at fire time.
   */
  currentRef: MutableRefObject<{ notes: string; hydrated: boolean; attemptId: string | null }>;
}

export function useAgencyNotes(options: {
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | undefined;
  accountId: string | undefined;
  /** The attempt the station holds now — `UseAgencyStationResult.currentAttemptId`. */
  currentAttemptId: string | null;
  /** Whether the notes route will accept a write — the pad gate's `notesEnabled`. */
  acceptingWrites: boolean;
  /**
   * Wrap-up redial: the attempt `currentAttemptId` redials (`attempt.redial
   * .of_attempt_id`), or null. When the draft this hook holds belongs to that
   * attempt, it moves to the new one (see the hydration effect).
   */
  carryFrom?: string | null;
}): AgencyNotesState {
  const { bootstrap, tenantId, accountId, currentAttemptId, acceptingWrites } = options;
  /** Read at hydration time, from the same render that moved `currentAttemptId`. */
  const carryFromRef = useLatestRef(options.carryFrom ?? null);
  /**
   * The draft as of the last hydration or edit, and the attempt it belongs to.
   * Not `notesRef`: by the time the hydration effect runs, that already names the
   * NEW attempt beside the OLD text.
   */
  const heldDraft = useRef<{ attemptId: string | null; notes: string }>({ attemptId: null, notes: '' });

  const [notes, setNotes] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [lastKeystrokeAt, setLastKeystrokeAt] = useState<number | null>(null);
  const [lastSaveSucceededAt, setLastSaveSucceededAt] = useState<number | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [notesInFlight, setNotesInFlight] = useState(false);
  const [notesFailure, setNotesFailure] = useState<'retryable' | 'terminal' | null>(null);
  const [notesForeignWrite, setNotesForeignWrite] = useState(false);

  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The save the debounce is holding, tagged with the attempt it belongs to. */
  const pendingNotes = useRef<{ attemptId: string; hydrated: boolean; value: string } | null>(null);
  const notesRef = useLatestRef({ notes, hydrated, attemptId: currentAttemptId });

  /**
   * **Sweep note keys older than 24h at boot.** 200 calls a day against a
   * never-pruned namespace eventually trips the storage quota, and a quota error
   * mid-shift surfaces as "notes stopped saving" with no explanation anywhere.
   */
  useEffect(() => {
    try {
      sweepStaleNoteKeys(window.localStorage, Date.now());
    } catch {
      // A storage failure at boot must not stop the console opening.
    }
  }, []);

  // ── Notes lifecycle, keyed by attempt ─────────────────────────────────────
  /**
   * Hydration. **Nothing may autosave before this completes** — a save racing the
   * restore step sends `''` and clears the server copy, and the agent then watches
   * their notes vanish from a field they were reading.
   */
  useEffect(() => {
    setHydrated(false);
    setNotesForeignWrite(false);
    setNotesFailure(null);
    setLastKeystrokeAt(null);
    setLastSaveSucceededAt(null);
    setLastUpdatedAt(null);

    if (currentAttemptId === null) {
      setNotes('');
      return;
    }

    const readLocal = (attemptId: string): string | null => {
      try {
        const raw = window.localStorage.getItem(notesStorageKey(attemptId));
        return raw ? ((JSON.parse(raw) as { notes?: string }).notes ?? '') : null;
      } catch {
        return null;
      }
    };

    let restored = readLocal(currentAttemptId);
    /**
     * ── Wrap-up redial: the draft follows the customer ──────────────────────────
     * A redial is a new attempt, so by default it would open on an empty field —
     * and the notes and disposition writes REPLACE `notes`, so whatever the agent
     * typed next would overwrite what they wrote about the dropped call. The server
     * has already copied the saved notes onto the redial; this carries the local
     * draft the same way a restored panel would get it: the draft is written under
     * the new attempt's key and hydrated from there. No request is made.
     *
     * Only when the redial names the attempt whose draft this console holds (in
     * memory, or in its local buffer after a reload), and only when the new attempt
     * has no draft of its own — one that does is newer (a reload after the move).
     */
    const carryFrom = carryFromRef.current;
    if (restored === null && carryFrom !== null && carryFrom !== currentAttemptId) {
      const carried = heldDraft.current.attemptId === carryFrom ? heldDraft.current.notes : readLocal(carryFrom);
      if (carried) {
        restored = carried;
        try {
          window.localStorage.setItem(
            notesStorageKey(currentAttemptId),
            JSON.stringify({ notes: carried, at: Date.now() }),
          );
          window.localStorage.removeItem(notesStorageKey(carryFrom));
        } catch {
          // Quota or blocked storage: the field still shows the draft in memory.
        }
      }
    }
    heldDraft.current = { attemptId: currentAttemptId, notes: restored ?? '' };
    setNotes(restored ?? '');
    setHydrated(true);
  }, [currentAttemptId, carryFromRef]);

  /**
   * The debounced save, keyed on the attempt that was on screen **when the agent
   * typed** — never the one live when the timer fires.
   *
   * Reading `notesRef.current.attemptId` here instead was cross-contact
   * contamination on a replace-semantics endpoint: a timer armed during attempt A
   * that fires after a new `reserved` for B sent A's closed-over text to B's notes
   * route, overwriting whatever B had. `hydrated` travels in the snapshot for the
   * same reason — it describes A's load, not B's.
   *
   * The UI setters are then guarded, because a late save for A must not paint its
   * result over the notes status line the agent is reading about B.
   */
  const flushNotes = useCallback(
    async (pending: { attemptId: string; hydrated: boolean; value: string }) => {
      const { attemptId, hydrated: wasHydrated, value } = pending;
      const stillCurrent = () => notesRef.current.attemptId === attemptId;

      if (stillCurrent()) setNotesInFlight(true);
      try {
        // The guard lives INSIDE the client: there is no argument shape here that
        // sends an unchecked empty string. `agent_edit` is the only provenance the
        // field can produce, and it is what licenses a real clear.
        const outcome = await saveAttemptNotes(
          { hydrated: wasHydrated, notes: value, editSource: 'agent_edit', attemptId },
          tenantId,
          accountId,
        );
        if (!outcome.saved) return;
        if (!stillCurrent()) return;
        setLastSaveSucceededAt(Date.now());
        setLastUpdatedAt(outcome.response.updated_at);
        setNotesFailure(null);
        // Computed against what was SENT, never the live field — the client hands
        // back the answer so there is nothing here to compare wrongly.
        setNotesForeignWrite(outcome.foreignWrite);
      } catch {
        if (stillCurrent()) setNotesFailure('terminal');
        // `failure` is always 'terminal' here: this function has no retryable
        // failure state today — the field is reserved for one it doesn't
        // currently implement. `foreign_write` is always false for the same
        // reason: a foreign write is a successful save that also flags someone
        // else wrote first, not a failure, so it is never reported from this
        // catch.
        if (stillCurrent() && bootstrap) {
          trackAgencyNotesSaveFailed({
            campaign_id: bootstrap.campaign_id,
            failure: 'terminal',
            foreign_write: false,
          });
        }
      } finally {
        if (stillCurrent()) setNotesInFlight(false);
      }
    },
    [tenantId, accountId, bootstrap, notesRef],
  );

  const onNotesEdit = useCallback(
    (value: string) => {
      setNotes(value);
      setLastKeystrokeAt(Date.now());
      // The local buffer is the failure buffer, not the durability story: invisible
      // when things work, and what makes the two failure rows honest.
      const attemptId = notesRef.current.attemptId;
      heldDraft.current = { attemptId, notes: value };
      if (attemptId !== null) {
        try {
          window.localStorage.setItem(
            notesStorageKey(attemptId),
            JSON.stringify({ notes: value, at: Date.now() }),
          );
        } catch {
          // Quota. The server save is still attempted.
        }
      }
      if (notesTimer.current !== null) clearTimeout(notesTimer.current);
      if (attemptId === null) return;
      // Snapshot, not a live read — see `flushNotes`.
      const pending = { attemptId, hydrated: notesRef.current.hydrated, value };
      pendingNotes.current = pending;
      notesTimer.current = setTimeout(() => {
        pendingNotes.current = null;
        void flushNotes(pending);
      }, NOTES_DEBOUNCE_MS);
    },
    [flushNotes, notesRef],
  );

  /**
   * A new attempt **flushes** the pending save rather than cancelling it.
   *
   * Cancelling would silently drop whatever the agent typed in the last
   * `NOTES_DEBOUNCE_MS` of the previous call — the one moment they are most likely
   * to be writing the outcome down. The snapshot carries the old attempt id, so the
   * write lands on the call it was written about.
   */
  useEffect(() => {
    const pending = pendingNotes.current;
    if (pending === null || pending.attemptId === currentAttemptId) return;
    if (notesTimer.current !== null) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    pendingNotes.current = null;
    void flushNotes(pending);
  }, [currentAttemptId, flushNotes]);

  useEffect(
    () => () => {
      if (notesTimer.current !== null) clearTimeout(notesTimer.current);
    },
    [],
  );

  const statusLine = useMemo(
    () =>
      notesStatus({
        notes,
        lastKeystrokeAt,
        lastSaveSucceededAt,
        lastUpdatedAt,
        inFlight: notesInFlight,
        failure: notesFailure,
        acceptingWrites,
      }),
    [notes, lastKeystrokeAt, lastSaveSucceededAt, lastUpdatedAt, notesInFlight, notesFailure, acceptingWrites],
  );

  return { notes, onNotesEdit, statusLine, foreignWrite: notesForeignWrite, currentRef: notesRef };
}
