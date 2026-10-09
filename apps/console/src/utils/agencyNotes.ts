/**
 * The notes status line and the autosave guards (§A.13.7, spec `868051f`).
 *
 * Pure, because every rule here is a rule about *truthfulness* and the way each
 * one fails is by looking fine. A static string, a local timestamp and an
 * unguarded empty save all pass a glance.
 */

/**
 * The six status-line states.
 *
 * **One static string cannot be true here, and reaching for one is how the
 * previous defect happened** — a single "Saved" spanning both a successful and a
 * failed save is indistinguishable to the agent.
 */
export type NotesStatusState =
  /** Empty, not yet typed in. */
  | 'resting'
  /** Last keystroke is newer than the last successful save. */
  | 'saving'
  /** Saved, and nothing typed since. */
  | 'saved'
  /** Save failed, a retry is pending. */
  | 'retry_pending'
  /** Save failed, retries exhausted or offline. */
  | 'failed'
  /**
   * Window closed and **everything reached the server**. Informational; nothing
   * is at risk.
   */
  | 'closed_clean'
  /**
   * Window closed **with text that never reached the server** — the agent was
   * mid-sentence when wrap-up ended, so their last edits live only in
   * `localStorage`.
   *
   * Split from `closed_clean` because one string across both was the
   * single-"Saved" defect in miniature, in **the last thing the agent ever sees
   * about that call**. And it is reachable, not theoretical: wrap-up ends on
   * `agent_state` and the autosave is debounced, so the gap is real.
   */
  | 'closed_lossy';

/**
 * Three tones, because **the colour must carry the same distinction the words
 * do.** Every state rendered as one muted `.field-hint` is the single-"Saved"
 * defect in visual form: the agent scans colour before reading words, and this
 * line is glanced at, not studied.
 *
 * **The rule, so the assignment is derived rather than memorised: `danger` means
 * the text is not getting there.**
 *
 * - `danger` — it is not going to arrive: retries exhausted, or the window closed
 *   with unsaved text.
 * - `warning` — not there *yet* but still trying (`retry_pending`), or it arrived
 *   but someone else's version is also in play (foreign write).
 * - `muted` — nothing is at risk, including a clean close. **Do not render the
 *   clean close as danger**: an alarm on a benign state is the same cry-wolf
 *   failure that keeps the last-write-wins caveat out of the resting copy.
 */
export type NotesStatusTone = 'muted' | 'warning' | 'danger';

const TONE_BY_STATE: Record<NotesStatusState, NotesStatusTone> = {
  resting: 'muted',
  saving: 'muted',
  saved: 'muted',
  retry_pending: 'warning',
  failed: 'danger',
  closed_clean: 'muted',
  closed_lossy: 'danger',
};

/**
 * Weight rises with colour, because **colour alone is not a distinction**
 * (§A.11) — a colour-blind agent, or a badly-calibrated agency-floor monitor,
 * must still see the difference.
 */
const WEIGHT_BY_TONE: Record<NotesStatusTone, 400 | 500 | 600> = {
  muted: 400,
  warning: 500,
  danger: 600,
};

/** Copy is verbatim from §A.13.7's table. `saved` is built with its timestamp. */
const COPY_BY_STATE: Record<Exclude<NotesStatusState, 'saved'>, string> = {
  resting: 'Notes save as you type.',
  saving: 'Saving…',
  retry_pending: 'Not saved yet — trying again. Still on this device.',
  failed: 'Not saved to the server. Still on this device — keep this tab open.',
  closed_clean: 'Notes are closed for this call.',
  // Names what was lost. The clean-close string plus a danger tone would leave
  // the agent to infer the loss from a colour.
  closed_lossy: "Notes are closed for this call — your last edits weren't saved.",
};

/**
 * The foreign-write notice — an **additional** line, not a replacement state, so
 * it can coexist with any of the six.
 *
 * `AgencyNotesResponse` echoes `notes`; an echo differing from what was sent means
 * another writer won between our request and its handling. A supervisor editing an
 * attempt's notes while the agent types is a **supported operation**, not an
 * anomaly, so this is a real state rather than a defensive branch.
 *
 * Deliberately **not** in the resting copy: a permanent last-write-wins caveat is
 * noise that trains the agent to ignore the line that matters on the day it is
 * not noise.
 */
export const NOTES_FOREIGN_WRITE_COPY = 'These notes were also changed elsewhere.';
export const NOTES_FOREIGN_WRITE_TONE: NotesStatusTone = 'warning';

export interface NotesStatusInput {
  /** Current field contents. */
  notes: string;
  /** Client ms of the agent's last keystroke, or null if they have not typed. */
  lastKeystrokeAt: number | null;
  /** Client ms at which the last save SUCCEEDED, for ordering only. */
  lastSaveSucceededAt: number | null;
  /** `updated_at` from the last successful response. **For display.** */
  lastUpdatedAt: string | null;
  /** Whether a save is in flight. */
  inFlight: boolean;
  /** How the last save failed, if it did. */
  failure: 'retryable' | 'terminal' | null;
  /** Whether the route still accepts writes (live or in wrap-up). */
  acceptingWrites: boolean;
}

export interface NotesStatus {
  state: NotesStatusState;
  tone: NotesStatusTone;
  weight: 400 | 500 | 600;
  /** The rendered line. */
  copy: string;
}

/**
 * Formats the saved timestamp as a wall-clock time in the agent's timezone.
 *
 * **From `updated_at`, never from local time.** This is the entire
 * last-write-wins mitigation, and it works because it is **falsifiable**: an agent
 * whose latest sentence did not land sees a timestamp that has stopped advancing.
 * A locally-generated "Saved just now" would keep claiming success no matter what
 * the server actually stored.
 *
 * Returns null for a missing or unparseable value. **The caller must not
 * substitute `Date.now()`** — an absent `updated_at` is a bug to surface, not to
 * paper over, and papering over it reintroduces exactly the unfalsifiable readout
 * this field exists to replace.
 */
export function formatSavedAt(updatedAt: string | null): string | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * The status line.
 *
 * **The rule that makes it honest is one comparison: is the last keystroke newer
 * than the last successful save?** If so the state is `saving`, never `saved`.
 * That comparison — not a timer, not the in-flight flag alone — is what decides,
 * and it removes the whole class of "says Saved while holding unsaved text".
 */
export function notesStatus(input: NotesStatusInput): NotesStatus {
  const state = resolveState(input);
  const tone = TONE_BY_STATE[state];

  let copy: string;
  if (state === 'saved') {
    const at = formatSavedAt(input.lastUpdatedAt);
    // No `updated_at` means we cannot make the falsifiable claim, so we do not
    // make the claim at all — "Saving…" is the honest fallback, and the caller
    // logs the missing field as the defect it is.
    if (at === null) return { state: 'saving', tone: 'muted', weight: WEIGHT_BY_TONE.muted, copy: COPY_BY_STATE.saving };
    copy = `Saved ${at}`;
  } else {
    copy = COPY_BY_STATE[state];
  }

  return { state, tone, weight: WEIGHT_BY_TONE[tone], copy };
}

/**
 * **The one comparison the whole line rests on: is the last keystroke newer than
 * the last successful save?**
 *
 * Extracted rather than inlined because it is asked at **two different moments**,
 * and that is exactly what splits the closed row in two:
 *
 *  1. *while the window is open* — deciding "Saving…" versus "Saved";
 *  2. *at the moment the window closes* — deciding whether the close was clean or
 *     lossy.
 *
 * One function for both means the two answers cannot drift apart, and the split
 * costs no new state to track.
 */
export function notesUnsaved(input: Pick<NotesStatusInput, 'lastKeystrokeAt' | 'lastSaveSucceededAt'>): boolean {
  if (input.lastKeystrokeAt === null) return false;
  return input.lastSaveSucceededAt === null || input.lastKeystrokeAt > input.lastSaveSucceededAt;
}

function resolveState(input: NotesStatusInput): NotesStatusState {
  if (!input.acceptingWrites) {
    // Asked at the second moment. A failure still in play also means the text
    // never arrived, so it counts as lossy even if the keystroke ordering alone
    // would not say so — the retry the agent was promised can no longer happen.
    const lost = notesUnsaved(input) || input.failure !== null;
    return lost ? 'closed_lossy' : 'closed_clean';
  }

  // Failure outranks the keystroke comparison: unsaved text plus a known failure
  // is a failure, not a save in progress.
  if (input.failure === 'terminal') return 'failed';
  if (input.failure === 'retryable') return 'retry_pending';

  if (notesUnsaved(input) || input.inFlight) return 'saving';
  if (input.lastSaveSucceededAt !== null) return 'saved';

  // Never typed in, nothing saved.
  return 'resting';
}

// ─── The autosave guards ────────────────────────────────────────────────────

/**
 * What caused the current field value. **Only `agent_edit` carries provenance.**
 *
 * The empty string is a legitimate value with destructive force, so it needs a
 * provenance check that a non-empty save does not.
 */
export type NotesEditSource =
  /** The agent typed, pasted, or deleted. The only source that may send `''`. */
  | 'agent_edit'
  /** Restored from `localStorage` or from a server read. */
  | 'hydration'
  /** Component mounted. */
  | 'mount'
  /** State reset, e.g. after a submit. */
  | 'reset'
  /** A `reserved` for a different attempt swapped the panel. */
  | 'attempt_switch';

export type AutosaveRefusal = 'not_hydrated' | 'empty_without_agent_provenance';

export type AutosaveDecision =
  | { allowed: true }
  | { allowed: false; refusal: AutosaveRefusal; diagnostic: string };

export interface AutosaveGuardInput {
  /** True once restore-from-local (and any server read) has completed. */
  hydrated: boolean;
  notes: string;
  /** What produced the current value. */
  editSource: NotesEditSource | null;
  attemptId: string;
}

/**
 * Whether an autosave may fire.
 *
 * **The hazard this exists for: `notes: ''` clears the attempt's notes
 * wholesale.** The request replaces rather than merges, so an autosave firing
 * while the field is momentarily empty destroys server-side notes the agent
 * already had — and they then watch them vanish from a field they were reading.
 *
 * Two rules, and neither is a blanket "reject empty", because an agent genuinely
 * clearing the field must still get through:
 *
 *  1. **Never autosave before hydration completes.** A save racing the
 *     restore-from-local step sends `''` and wipes the server copy.
 *  2. **An empty save must be caused by the agent emptying the field**, as a
 *     deliberate edit — never by a render, a state reset, an attempt switch, or a
 *     mount.
 *
 * Non-empty saves need only rule 1. That asymmetry is the point: a non-empty save
 * cannot destroy anything, so gating it on provenance would block the legitimate
 * case of flushing hydrated local text up to a server that never received it.
 */
export function mayAutosave(input: AutosaveGuardInput): AutosaveDecision {
  if (!input.hydrated) {
    return {
      allowed: false,
      refusal: 'not_hydrated',
      diagnostic: `Refused a notes autosave for attempt ${input.attemptId} before hydration completed; sending it would have cleared the server copy`,
    };
  }

  // Whitespace-only is treated as empty: it clears just as destructively, and
  // trimming here costs nothing.
  const isEmpty = input.notes.trim().length === 0;
  if (isEmpty && input.editSource !== 'agent_edit') {
    return {
      allowed: false,
      refusal: 'empty_without_agent_provenance',
      diagnostic: `Refused an empty notes autosave for attempt ${input.attemptId} caused by '${input.editSource ?? 'unknown'}' rather than an agent edit; the empty string clears notes wholesale`,
    };
  }

  return { allowed: true };
}

/**
 * Whether the response's echo indicates another writer won.
 *
 * Compared against **what we sent**, not against the current field: the agent has
 * very likely typed more since, and comparing to the live value would report a
 * foreign write on every save that overlapped a keystroke.
 */
export function detectForeignWrite(sentNotes: string, echoedNotes: string): boolean {
  return sentNotes !== echoedNotes;
}

// ─── The local failure buffer ───────────────────────────────────────────────

/**
 * `localStorage` key for one attempt's notes.
 *
 * **Demoted from the durability story to the failure buffer** now that the route
 * ships: invisible when things work, and what makes the two failure rows honest
 * rather than merely apologetic. Still needed because the server save can fail,
 * and because §A.8.1's network drop currently ends the call immediately — so at
 * the moment it matters most, the last server save may already be seconds stale.
 */
export function notesStorageKey(attemptId: string): string {
  return `agency.notes.${attemptId}`;
}

const NOTES_KEY_PREFIX = 'agency.notes.';

/** Keys older than this are swept at console boot. */
export const NOTES_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StoredNotes {
  notes: string;
  /** Client ms when written, for the sweep only. */
  at: number;
}

/**
 * Sweeps note keys older than 24h.
 *
 * 200 calls a day against a never-pruned namespace eventually trips the storage
 * quota, and a quota error mid-shift surfaces as "notes stopped saving" with no
 * explanation anywhere.
 *
 * Returns the keys removed, so boot can log the count. Unparseable and
 * timestamp-less entries are swept too: they cannot be aged, so keeping them
 * forever is the leak this function exists to prevent.
 */
export function sweepStaleNoteKeys(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>, now: number): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(NOTES_KEY_PREFIX)) candidates.push(key);
  }

  const removed: string[] = [];
  for (const key of candidates) {
    const raw = storage.getItem(key);
    let keep = false;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredNotes>;
        keep = typeof parsed.at === 'number' && now - parsed.at < NOTES_KEY_MAX_AGE_MS;
      } catch {
        keep = false;
      }
    }
    if (!keep) {
      storage.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}
