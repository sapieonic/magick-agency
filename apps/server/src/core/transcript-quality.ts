/**
 * PORT NOTE (magick-agency): a SUBSET of core `src/core/transcript-quality.ts`
 * (v1.123.2, lines 31-84), verbatim: only `conversationEntrySource` and
 * `isSpokenEntry`, which the analysis prompt builder uses to drop `silent_marker`
 * entries. The rest of core's module (leak and repeat detection, intro-clip
 * placement, `inspectAssistantTranscript`) is the AI call pipeline's and is not
 * carried (plan §2).
 */

import type { ConversationEntry, ConversationEntrySource } from '@magick-agency/db/models/conversation-entry.model';

// ── Provenance (L1 / R2) ─────────────────────────────────────────────────────

/** An entry's provenance with the historical default applied: absent ⇒ `model`. */
export function conversationEntrySource(entry: Pick<ConversationEntry, 'source'>): ConversationEntrySource {
  return entry.source ?? 'model';
}

/** Whether an entry is something the caller actually heard or said. */
export function isSpokenEntry(entry: Pick<ConversationEntry, 'source'>): boolean {
  return conversationEntrySource(entry) !== 'silent_marker';
}
