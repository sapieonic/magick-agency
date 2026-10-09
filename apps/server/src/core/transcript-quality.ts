/**
 * Transcript-entry provenance helpers: `conversationEntrySource` and
 * `isSpokenEntry`, which the analysis prompt builder uses to drop `silent_marker`
 * entries.
 */

import type { ConversationEntry, ConversationEntrySource } from '@magick-agency/db/models/conversation-entry.model';

// ── Provenance ─────────────────────────────────────────────────────

/** An entry's provenance with the historical default applied: absent ⇒ `model`. */
export function conversationEntrySource(entry: Pick<ConversationEntry, 'source'>): ConversationEntrySource {
  return entry.source ?? 'model';
}

/** Whether an entry is something the caller actually heard or said. */
export function isSpokenEntry(entry: Pick<ConversationEntry, 'source'>): boolean {
  return conversationEntrySource(entry) !== 'silent_marker';
}
