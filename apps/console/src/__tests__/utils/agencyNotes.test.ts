import { describe, it, expect } from 'vitest';
import {
  notesStatus,
  formatSavedAt,
  mayAutosave,
  detectForeignWrite,
  notesStorageKey,
  notesUnsaved,
  sweepStaleNoteKeys,
  NOTES_FOREIGN_WRITE_COPY,
  NOTES_FOREIGN_WRITE_TONE,
  type NotesStatusInput,
  type NotesEditSource,
} from '../../utils/agencyNotes';

const ATTEMPT = 'attempt-1';

function input(overrides: Partial<NotesStatusInput> = {}): NotesStatusInput {
  return {
    notes: '',
    lastKeystrokeAt: null,
    lastSaveSucceededAt: null,
    lastUpdatedAt: null,
    inFlight: false,
    failure: null,
    acceptingWrites: true,
    ...overrides,
  };
}

// ─── The hazard, first ──────────────────────────────────────────────────────

describe('the destructive-clear hazard — notes: \'\' replaces rather than merges', () => {
  /**
   * An autosave firing while the field is momentarily empty destroys server-side
   * notes the agent already had, and they watch them vanish from a field they
   * were reading. Neither guard may be a blanket "reject empty": an agent
   * genuinely clearing the field has to get through.
   */
  const NON_AGENT_SOURCES: NotesEditSource[] = ['hydration', 'mount', 'reset', 'attempt_switch'];

  it('refuses any autosave before hydration completes', () => {
    // A save racing the restore-from-local step sends '' and wipes the server copy.
    const decision = mayAutosave({
      hydrated: false,
      notes: '',
      editSource: 'agent_edit',
      attemptId: ATTEMPT,
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ refusal: 'not_hydrated' });
  });

  it('refuses a NON-EMPTY save before hydration too', () => {
    // Hydration has not run, so whatever is in the field is not the agent's work
    // and could still overwrite a server copy we have not read yet.
    expect(mayAutosave({
      hydrated: false,
      notes: 'half a sentence',
      editSource: 'agent_edit',
      attemptId: ATTEMPT,
    }).allowed).toBe(false);
  });

  it.each(NON_AGENT_SOURCES)('refuses an empty save caused by %s', (editSource) => {
    const decision = mayAutosave({ hydrated: true, notes: '', editSource, attemptId: ATTEMPT });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ refusal: 'empty_without_agent_provenance' });
  });

  it('refuses an empty save with no known source at all', () => {
    expect(mayAutosave({ hydrated: true, notes: '', editSource: null, attemptId: ATTEMPT }).allowed)
      .toBe(false);
  });

  it('treats whitespace-only as empty — it clears just as destructively', () => {
    expect(mayAutosave({ hydrated: true, notes: '   \n\t ', editSource: 'reset', attemptId: ATTEMPT }).allowed)
      .toBe(false);
  });

  it('ALLOWS a real clear — the agent deliberately emptying the field', () => {
    // The guard cannot be a blanket rejection, or an agent who wants their notes
    // gone cannot get rid of them.
    expect(mayAutosave({ hydrated: true, notes: '', editSource: 'agent_edit', attemptId: ATTEMPT }))
      .toEqual({ allowed: true });
  });

  it('allows a non-empty save from any source once hydrated', () => {
    // Deliberate asymmetry: a non-empty save cannot destroy anything, and gating
    // it on provenance would block flushing hydrated local text up to a server
    // that never received it.
    for (const editSource of [...NON_AGENT_SOURCES, 'agent_edit'] as NotesEditSource[]) {
      expect(mayAutosave({ hydrated: true, notes: 'real text', editSource, attemptId: ATTEMPT }).allowed)
        .toBe(true);
    }
  });

  it('names the attempt and the cause in the diagnostic', () => {
    const decision = mayAutosave({
      hydrated: true,
      notes: '',
      editSource: 'attempt_switch',
      attemptId: 'attempt-xyz',
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.diagnostic).toContain('attempt-xyz');
    expect(decision.diagnostic).toContain('attempt_switch');
  });
});

// ─── The honesty rule ───────────────────────────────────────────────────────

describe('the honesty rule — one comparison', () => {
  it('says Saving, never Saved, when the last keystroke is newer than the last save', () => {
    // This single boolean removes the whole class of "says Saved while holding
    // unsaved text".
    const status = notesStatus(input({
      notes: 'typed more since the save',
      lastSaveSucceededAt: 1_000,
      lastUpdatedAt: '2026-08-11T14:32:00.000Z',
      lastKeystrokeAt: 2_000,
    }));
    expect(status.state).toBe('saving');
    expect(status.copy).toBe('Saving…');
    expect(status.copy).not.toContain('Saved');
  });

  it('says Saved only when nothing has been typed since', () => {
    const status = notesStatus(input({
      notes: 'all filed',
      lastKeystrokeAt: 1_000,
      lastSaveSucceededAt: 2_000,
      lastUpdatedAt: '2026-08-11T14:32:00.000Z',
    }));
    expect(status.state).toBe('saved');
    expect(status.copy).toMatch(/^Saved \d{2}:\d{2}$/);
  });

  it('is decided by the comparison, not by the in-flight flag alone', () => {
    // A save can be in flight with no newer keystrokes (the debounce fired and
    // the agent stopped typing) — still "Saving…".
    expect(notesStatus(input({ notes: 'x', lastKeystrokeAt: 1_000, inFlight: true })).state)
      .toBe('saving');
  });

  it('rests before the agent has typed anything', () => {
    const status = notesStatus(input());
    expect(status.state).toBe('resting');
    expect(status.copy).toBe('Notes save as you type.');
  });
});

describe('the timestamp is falsifiable — from updated_at, never local time', () => {
  it('renders the wall-clock time the SERVER recorded', () => {
    // An agent whose latest sentence did not land sees a timestamp that has
    // stopped advancing. That is the entire last-write-wins mitigation.
    const at = formatSavedAt('2026-08-11T14:32:09.000Z');
    expect(at).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns null for a missing or unparseable updated_at', () => {
    expect(formatSavedAt(null)).toBeNull();
    expect(formatSavedAt('')).toBeNull();
    expect(formatSavedAt('whenever')).toBeNull();
  });

  it('falls back to Saving rather than inventing a local timestamp', () => {
    // Substituting Date.now() would reintroduce exactly the unfalsifiable readout
    // `updated_at` exists to replace: "Saved just now" claiming success no matter
    // what the server stored. Absent field ⇒ we do not make the claim.
    const status = notesStatus(input({
      notes: 'x',
      lastKeystrokeAt: 1_000,
      lastSaveSucceededAt: 2_000,
      lastUpdatedAt: null,
    }));
    expect(status.state).toBe('saving');
    expect(status.copy).not.toMatch(/Saved/);
  });
});

// ─── Colour and weight ──────────────────────────────────────────────────────

describe('colour carries the same distinction the words do', () => {
  it('is danger exactly where the text is not going to arrive', () => {
    // The rule, not a memorised list: danger means the text is not getting there.
    expect(notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'terminal' })).tone)
      .toBe('danger');
    expect(notesStatus(input({ notes: 'x', lastKeystrokeAt: 5_000, acceptingWrites: false })).tone)
      .toBe('danger');
  });

  it('is warning while a retry is pending, and for a foreign write', () => {
    expect(notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'retryable' })).tone)
      .toBe('warning');
    expect(NOTES_FOREIGN_WRITE_TONE).toBe('warning');
  });

  it('is muted wherever nothing is at risk — including a clean close', () => {
    expect(notesStatus(input()).tone).toBe('muted');
    expect(notesStatus(input({ notes: 'x', lastKeystrokeAt: 1 })).tone).toBe('muted');
    expect(notesStatus(input({
      lastKeystrokeAt: 1, lastSaveSucceededAt: 2, lastUpdatedAt: '2026-08-11T14:32:00.000Z',
    })).tone).toBe('muted');
    expect(notesStatus(input({
      lastKeystrokeAt: 1, lastSaveSucceededAt: 2, acceptingWrites: false,
    })).tone).toBe('muted');
  });

  it('does not render a failed save identically to "Notes save as you type"', () => {
    // The single-"Saved" defect in visual form. The agent scans colour before
    // reading words, and this line is glanced at, not studied.
    const resting = notesStatus(input());
    const failed = notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'terminal' }));
    expect(failed.tone).not.toBe(resting.tone);
    expect(failed.copy).not.toBe(resting.copy);
  });

  it('raises weight with colour, because colour alone is not a distinction', () => {
    const muted = notesStatus(input());
    const warning = notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'retryable' }));
    const danger = notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'terminal' }));
    expect(muted.weight).toBeLessThan(warning.weight);
    expect(warning.weight).toBeLessThan(danger.weight);
  });

  it('uses exactly three tones across all seven states', () => {
    const states = [
      input(),
      input({ notes: 'x', lastKeystrokeAt: 1 }),
      input({ lastKeystrokeAt: 1, lastSaveSucceededAt: 2, lastUpdatedAt: '2026-08-11T14:32:00.000Z' }),
      input({ notes: 'x', lastKeystrokeAt: 1, failure: 'retryable' }),
      input({ notes: 'x', lastKeystrokeAt: 1, failure: 'terminal' }),
      input({ lastKeystrokeAt: 1, lastSaveSucceededAt: 2, acceptingWrites: false }),
      input({ notes: 'x', lastKeystrokeAt: 5_000, acceptingWrites: false }),
    ].map((i) => notesStatus(i));

    expect(new Set(states.map((s) => s.state)).size).toBe(7);
    expect(new Set(states.map((s) => s.tone))).toEqual(new Set(['muted', 'warning', 'danger']));
  });
});

describe('the closed row splits in two — the last thing the agent sees', () => {
  /**
   * One string across a benign close (everything saved, field merely disabled)
   * and a lossy one (mid-sentence when wrap-up ended, last edits only in
   * `localStorage`) is the single-"Saved" defect in miniature — and this is where
   * the honesty rule matters most, because it is the final word on that call.
   *
   * Reachable, not theoretical: wrap-up ends on `agent_state` and the autosave is
   * debounced, so the gap is real.
   */
  const CLEAN = input({ lastKeystrokeAt: 1_000, lastSaveSucceededAt: 2_000, acceptingWrites: false });
  const LOSSY = input({ notes: 'half a sentence', lastKeystrokeAt: 5_000, lastSaveSucceededAt: 2_000, acceptingWrites: false });

  it('names what was lost on a lossy close, and is danger', () => {
    const status = notesStatus(LOSSY);
    expect(status.state).toBe('closed_lossy');
    expect(status.copy).toBe("Notes are closed for this call — your last edits weren't saved.");
    expect(status.tone).toBe('danger');
  });

  it('does NOT render the clean close as danger — the converse matters as much', () => {
    // Nothing is at risk, the field is disabled, and an alarm on a benign state is
    // the same cry-wolf failure that keeps the last-write-wins caveat out of the
    // resting copy.
    const status = notesStatus(CLEAN);
    expect(status.state).toBe('closed_clean');
    expect(status.copy).toBe('Notes are closed for this call.');
    expect(status.tone).toBe('muted');
  });

  it('distinguishes the two in BOTH words and colour, not one or the other', () => {
    // Same tone with different words, or same words with different tone, each
    // reintroduces half the defect.
    const clean = notesStatus(CLEAN);
    const lossy = notesStatus(LOSSY);
    expect(lossy.copy).not.toBe(clean.copy);
    expect(lossy.tone).not.toBe(clean.tone);
    expect(lossy.weight).toBeGreaterThan(clean.weight);
  });

  it('treats an unresolved failure at close as lossy, even with older keystrokes', () => {
    // The retry the agent was promised can no longer happen, so the text never
    // arrived — regardless of what the keystroke ordering alone would say.
    expect(notesStatus(input({
      lastKeystrokeAt: 1_000,
      lastSaveSucceededAt: 2_000,
      failure: 'retryable',
      acceptingWrites: false,
    })).state).toBe('closed_lossy');
  });

  it('is clean when the agent never typed at all', () => {
    expect(notesStatus(input({ acceptingWrites: false })).state).toBe('closed_clean');
  });
});

describe('notesUnsaved — one comparison asked at two moments', () => {
  /**
   * Extracted rather than inlined precisely because the closed split needs the
   * same question answered at a second moment. One function means the two answers
   * cannot drift apart.
   */
  it('is false before the agent types', () => {
    expect(notesUnsaved({ lastKeystrokeAt: null, lastSaveSucceededAt: null })).toBe(false);
    expect(notesUnsaved({ lastKeystrokeAt: null, lastSaveSucceededAt: 5_000 })).toBe(false);
  });

  it('is true when nothing has ever saved but the agent has typed', () => {
    expect(notesUnsaved({ lastKeystrokeAt: 1_000, lastSaveSucceededAt: null })).toBe(true);
  });

  it('is true when the keystroke is newer than the save', () => {
    expect(notesUnsaved({ lastKeystrokeAt: 2_000, lastSaveSucceededAt: 1_000 })).toBe(true);
  });

  it('is false when the save is newer', () => {
    expect(notesUnsaved({ lastKeystrokeAt: 1_000, lastSaveSucceededAt: 2_000 })).toBe(false);
  });

  it('drives the open-window state and the close outcome identically', () => {
    // The property that makes extraction worth it: same inputs, same verdict, at
    // whichever moment it is asked.
    const unsavedish = { notes: 'x', lastKeystrokeAt: 5_000, lastSaveSucceededAt: 2_000 };
    expect(notesUnsaved(unsavedish)).toBe(true);
    expect(notesStatus(input({ ...unsavedish })).state).toBe('saving');
    expect(notesStatus(input({ ...unsavedish, acceptingWrites: false })).state).toBe('closed_lossy');

    const savedish = { notes: 'x', lastKeystrokeAt: 1_000, lastSaveSucceededAt: 2_000, lastUpdatedAt: '2026-08-11T14:32:00.000Z' };
    expect(notesUnsaved(savedish)).toBe(false);
    expect(notesStatus(input({ ...savedish })).state).toBe('saved');
    expect(notesStatus(input({ ...savedish, acceptingWrites: false })).state).toBe('closed_clean');
  });
});

describe('notes copy never blurs into the disposition', () => {
  it('says nothing that could read as the disposition being saved', () => {
    // An agent who reads "Saved" and walks away from a required disposition has
    // been misled by THIS line. The route does not end wrap-up and does not
    // satisfy `requires_disposition`.
    const all = [
      notesStatus(input()),
      notesStatus(input({ notes: 'x', lastKeystrokeAt: 1 })),
      notesStatus(input({ lastKeystrokeAt: 1, lastSaveSucceededAt: 2, lastUpdatedAt: '2026-08-11T14:32:00.000Z' })),
      notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'retryable' })),
      notesStatus(input({ notes: 'x', lastKeystrokeAt: 1, failure: 'terminal' })),
      notesStatus(input({ acceptingWrites: false })),
      notesStatus(input({ notes: 'x', lastKeystrokeAt: 5_000, acceptingWrites: false })),
    ].map((s) => s.copy);

    for (const copy of all) {
      expect(copy.toLowerCase()).not.toContain('disposition');
      expect(copy.toLowerCase()).not.toContain('call saved');
    }
  });
});

// ─── Foreign writes ─────────────────────────────────────────────────────────

describe('foreign-write detection', () => {
  it('flags an echo that differs from what was sent', () => {
    expect(detectForeignWrite('agent text', 'supervisor text')).toBe(true);
  });

  it('does not flag a faithful echo', () => {
    expect(detectForeignWrite('agent text', 'agent text')).toBe(false);
  });

  it('compares against what was SENT, not the live field', () => {
    // The agent has very likely typed more since; comparing to the live value
    // would report a foreign write on every save that overlapped a keystroke.
    const sent = 'first sentence';
    expect(detectForeignWrite(sent, sent)).toBe(false);
  });

  it('has copy that keeps the agent\'s text rather than announcing a loss', () => {
    // "Do not clobber" is the behaviour; the copy has to match it. A supervisor
    // writing `on_behalf` is a supported operation, not an anomaly.
    expect(NOTES_FOREIGN_WRITE_COPY).toBe('These notes were also changed elsewhere.');
    expect(NOTES_FOREIGN_WRITE_COPY.toLowerCase()).not.toContain('lost');
    expect(NOTES_FOREIGN_WRITE_COPY.toLowerCase()).not.toContain('overwritten');
  });
});

// ─── The failure buffer ─────────────────────────────────────────────────────

describe('the local failure buffer', () => {
  function fakeStorage(entries: Record<string, string>) {
    const map = new Map(Object.entries(entries));
    return {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      removeItem: (k: string) => void map.delete(k),
      _map: map,
    };
  }

  const NOW = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it('keys by attempt', () => {
    expect(notesStorageKey('attempt-9')).toBe('agency.notes.attempt-9');
  });

  it('sweeps keys older than 24h at boot', () => {
    // 200 calls a day against a never-pruned namespace trips the storage quota,
    // and a quota error mid-shift surfaces as "notes stopped saving" with no
    // explanation.
    const storage = fakeStorage({
      'agency.notes.old': JSON.stringify({ notes: 'a', at: NOW - DAY - 1 }),
      'agency.notes.fresh': JSON.stringify({ notes: 'b', at: NOW - 1_000 }),
    });
    expect(sweepStaleNoteKeys(storage, NOW)).toEqual(['agency.notes.old']);
    expect(storage._map.has('agency.notes.fresh')).toBe(true);
  });

  it('sweeps unparseable and timestamp-less entries — they can never be aged', () => {
    const storage = fakeStorage({
      'agency.notes.broken': 'not json',
      'agency.notes.undated': JSON.stringify({ notes: 'c' }),
    });
    expect(sweepStaleNoteKeys(storage, NOW).sort()).toEqual([
      'agency.notes.broken',
      'agency.notes.undated',
    ]);
  });

  it('leaves unrelated keys alone', () => {
    const storage = fakeStorage({
      'agency.notes.old': JSON.stringify({ notes: 'a', at: NOW - DAY - 1 }),
      'auth.token': 'keep me',
      'agency.somethingelse': 'keep me too',
    });
    sweepStaleNoteKeys(storage, NOW);
    expect(storage._map.has('auth.token')).toBe(true);
    expect(storage._map.has('agency.somethingelse')).toBe(true);
  });
});
