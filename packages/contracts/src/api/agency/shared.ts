/**
 * Shapes the agency call-detail and analysis-profile files need from cusui type
 * modules that are otherwise NOT ported (they describe the AI-calling product).
 *
 * PORT NOTE (magick-agency): verbatim excerpts, not a re-design —
 *   - `AnalyticsDimension` / `StoredAnalyticsDimension` from
 *     `magick-comms-cusui/src/types/prompt.ts:7-27` (cusui v2.96.0,
 *     ee5beb4400ec1fb5fdf6049871681ae6875e8d29), imported there by
 *     `call-analysis-profile.ts`;
 *   - `CallAnalysisResult` from `magick-comms-cusui/src/types/call.ts:33-58`,
 *     imported there by `webrtc-call.ts`.
 * The rest of `prompt.ts` (call scripts) and `call.ts` (AI calls) is out of scope
 * (AI calling is not part of Magick Agency v1). See `../../../PORTING.md`.
 */

/** A dimension as we SEND it. Core's `analyticsDimensionSchema` requires a
 *  non-empty key and description, so the assemblers (`toValidDimensions`) must
 *  produce exactly this — keep it strict. */
export interface AnalyticsDimension {
  key: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'enum';
  options?: string[];
}

/** A dimension as core ECHOES it back, which is not the same guarantee: the
 *  dimension list is stored as JSONB and rows written before the current schema
 *  (or by an import) can carry NULLs where a send would require a string. Read
 *  paths use this shape so the compiler makes them normalize — the editor's
 *  `.trim()` on a NULL description is the crash this type exists to prevent. */
export interface StoredAnalyticsDimension {
  key: string | null;
  description: string | null;
  type: 'boolean' | 'string' | 'number' | 'enum';
  options?: (string | null)[] | null;
}

export interface CallAnalysisResult {
  _meta?: {
    model?: string;
    provider?: string;
    latency_ms?: number;
    analyzed_at?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  common?: {
    summary?: string;
    key_topics?: string[];
    overall_sentiment?: { label: string; score: number };
    turn_sentiments?: Array<{ turn_index: number; role: string; sentiment: { label: string; score: number } }>;
    conversation_quality?: Record<string, unknown>;
  };
  custom?: Record<string, unknown>;
  // Legacy flat shape fallback
  overall_sentiment?: { label: string; score: number };
  key_topics?: string[];
  conversation_quality?: Record<string, unknown>;
  summary?: string;
  custom_dimensions?: Record<string, unknown>;
}
