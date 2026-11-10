import { useCallback, useEffect, useRef, useState } from 'react';
import { notesStatus, type NotesStatus } from '../utils/agencyNotes';
import { useLatestRef } from './useLatestRef';

/** Quiet time after the last keystroke before the draft is sent; a retry waits four times as long. */
export const NOTES_DEBOUNCE_MS = 700;

/** How a save's answer reads to the notes line. */
export type NotesSaveSettled =
  | { ok: true; /** The stamp the line shows as "Saved …". */ updatedAt: string }
  | { ok: false; /** The call no longer takes writes. */ terminal: boolean; /** Send again after a pause. */ retry: boolean };

export interface CallNotesAutosaveOptions<C extends { id: string }, R> {
  /** The call the notes belong to; null when there is none (nothing is sent). */
  call: C | null;
  /** The text in the box, for the status line. */
  notes: string;
  /** Sends the current draft for this call; null when there is nowhere to send (no tenant or account). */
  send: (call: C) => Promise<R> | null;
  /**
   * Reads the answer, only while the call it was sent for is still the one on screen. The
   * caller's own side effects (adopting the returned call, field errors) happen here.
   */
  settle: (result: R, sentAt: number) => NotesSaveSettled;
}

export interface CallNotesAutosave {
  /** The "Saving… / Saved 14:02 / Not saved" line under the notes box. */
  status: NotesStatus;
  /** Arms (or re-arms) the debounced save, when there is a call. */
  scheduleSave: () => void;
  /** Drops a pending save (the outcome save carries the notes itself). */
  cancelSave: () => void;
  /** The agent typed: stamps the keystroke so the line stops claiming "Saved". */
  markKeystroke: () => void;
  /** Forgets the save stamps (a different call). */
  resetStamps: () => void;
  /** Forgets an in-flight or failed save (the call left). */
  clearSaveState: () => void;
}

/**
 * Notes autosaved onto a live call, shared by the soft phone and the inbound station: the
 * debounce, the retry after a refusal that may pass, the clear on unmount, and the status line.
 * What is sent and what a refusal means stay with the caller (`send`, `settle`).
 */
export function useCallNotesAutosave<C extends { id: string }, R>(options: CallNotesAutosaveOptions<C, R>): CallNotesAutosave {
  const { call, notes, send, settle } = options;
  const notesSaveRef = useRef<{ lastKeystrokeAt: number | null; lastSaveSucceededAt: number | null; lastUpdatedAt: string | null }>({
    lastKeystrokeAt: null,
    lastSaveSucceededAt: null,
    lastUpdatedAt: null,
  });
  const [notesMeta, setNotesMeta] = useState<{ inFlight: boolean; failure: 'retryable' | 'terminal' | null; tick: number }>({
    inFlight: false,
    failure: null,
    tick: 0,
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRef = useLatestRef(call);

  const flushSave = useCallback(async () => {
    saveTimerRef.current = null;
    const target = callRef.current;
    if (!target) return;
    const sentAt = Date.now();
    const pending = send(target);
    if (!pending) return;
    setNotesMeta((m) => ({ ...m, inFlight: true }));
    const result = await pending;
    if (callRef.current?.id !== target.id) return;
    const settled = settle(result, sentAt);
    if (settled.ok) {
      notesSaveRef.current = { ...notesSaveRef.current, lastSaveSucceededAt: sentAt, lastUpdatedAt: settled.updatedAt };
      setNotesMeta((m) => ({ inFlight: false, failure: null, tick: m.tick + 1 }));
      return;
    }
    setNotesMeta((m) => ({ inFlight: false, failure: settled.terminal ? 'terminal' : 'retryable', tick: m.tick + 1 }));
    if (settled.retry) saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS * 4);
  }, [callRef, send, settle]);

  const scheduleSave = useCallback(() => {
    if (!callRef.current) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void flushSave(), NOTES_DEBOUNCE_MS);
  }, [callRef, flushSave]);

  const cancelSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
  }, []);

  const markKeystroke = useCallback(() => {
    notesSaveRef.current = { ...notesSaveRef.current, lastKeystrokeAt: Date.now() };
    setNotesMeta((m) => ({ ...m, tick: m.tick + 1 }));
  }, []);

  const resetStamps = useCallback(() => {
    notesSaveRef.current = { lastKeystrokeAt: null, lastSaveSucceededAt: null, lastUpdatedAt: null };
  }, []);

  const clearSaveState = useCallback(() => {
    setNotesMeta((m) => ({ ...m, inFlight: false, failure: null }));
  }, []);

  const status = notesStatus({
    notes,
    lastKeystrokeAt: notesSaveRef.current.lastKeystrokeAt,
    lastSaveSucceededAt: notesSaveRef.current.lastSaveSucceededAt,
    lastUpdatedAt: notesSaveRef.current.lastUpdatedAt,
    inFlight: notesMeta.inFlight,
    failure: notesMeta.failure,
    acceptingWrites: call !== null,
  });

  return { status, scheduleSave, cancelSave, markKeystroke, resetStamps, clearSaveState };
}
