// PORT NOTE (magick-agency): a SUBSET of core `src/db/models/call.model.ts`
// (v1.123.2, lines 154-196), verbatim: `ConversationEntry` and its provenance
// type, which the analysis service and prompt builder take as input. Core keeps
// them in `call.model.ts`; that file here is lead-owned (shared infrastructure,
// holds only the analysis RESULT subset), so lane D carries these in a sibling
// file instead of editing it.

/**
 * Where an assistant entry in `conversation_log` came from.
 *
 *   `model`          — the pipeline's own output transcript. ABSENT means the
 *                      same thing: rows written before this field existed, and
 *                      every model turn written since, carry no `source` at all,
 *                      so a reader must treat a missing value as `model`
 *                      (`conversationEntrySource` in `core/transcript-quality.ts`).
 *   `intro_clip`     — the pre-recorded intro the platform played before the AI
 *                      spoke. `content` is the operator's `intro_transcript`, or a
 *                      fixed placeholder — never the audio file's name.
 *   `nudge_fallback` — the canned TTS re-prompt the silence-nudge ladder played
 *                      because the model would not speak.
 *   `silent_marker`  — a `[Silence]`/`[No response]`-shaped transcript on a turn
 *                      whose audio was scored silent: the caller heard nothing, so
 *                      it is not an utterance. Stored verbatim (analysts need it),
 *                      excluded from post-call analysis input and turn counts.
 *
 * Additive JSONB, no migration: a reader that ignores the field sees exactly the
 * shape it always did.
 */
export type ConversationEntrySource = 'model' | 'intro_clip' | 'nudge_fallback' | 'silent_marker';

export interface ConversationEntry {
  role: 'assistant' | 'user';
  content: string;
  timestamp: string;
  language?: string;
  confidence?: number;
  /**
   * The assistant turn was cut off by a barge-in, so `content` is what the model
   * generated, not what the caller heard (see `ConversationTurn.interrupted`).
   * Additive JSONB, no migration; absent means not known to be interrupted.
   */
  interrupted?: boolean;
  /** Provenance of an assistant entry. Absent ⇒ `model`. See {@link ConversationEntrySource}. */
  source?: ConversationEntrySource;
}
