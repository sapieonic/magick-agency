/**
 * The console has no AI-call model (status, pipeline, tools, retrieval,
 * escalation, bulk recipients). The shared call-detail component
 * (`components/calls/CallDetailSections.tsx`) needs only the two shapes below:
 *  - `CallAnalysisResult` — carried by the contract
 *    (`@magick-agency/contracts/api/agency/shared`) and re-exported from there;
 *  - `ConversationEntry` — defined here.
 */
export type { CallAnalysisResult } from '@magick-agency/contracts/api/agency/shared';

export interface ConversationEntry {
  role: 'assistant' | 'user';
  content: string;
  language?: string;
  confidence?: number;
  timestamp?: string;
}
