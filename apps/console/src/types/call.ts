/**
 * PORT NOTE (magick-agency): cusui's `src/types/call.ts` @ ee5beb44 describes the
 * AI call (status, pipeline, tools, retrieval, escalation, bulk recipients), which
 * is not ported. The shared call-detail component (`components/calls/
 * CallDetailSections.tsx`) needs only the two shapes below:
 *  - `CallAnalysisResult` — already carried verbatim in the contract
 *    (`@magick-agency/contracts/api/agency/shared`, an excerpt of this same file),
 *    and re-exported from there;
 *  - `ConversationEntry` — verbatim from `src/types/call.ts:25-31`.
 */
export type { CallAnalysisResult } from '@magick-agency/contracts/api/agency/shared';

export interface ConversationEntry {
  role: 'assistant' | 'user';
  content: string;
  language?: string;
  confidence?: number;
  timestamp?: string;
}
