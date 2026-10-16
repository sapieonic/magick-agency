/**
 * Shapes the agency call-detail and analysis-profile files need from console type
 * modules.
 *
 *   - `AnalyticsDimension` / `StoredAnalyticsDimension` and the dimension type
 *     list, used by `call-analysis-profile.ts` and the server's dimension validator;
 *   - `CallAnalysisResult`, used by `webrtc-call.ts`.
 */

/**
 * The value types a dimension may declare. The server's `analyticsDimensionSchema`
 * builds its `z.enum` from this list.
 */
export const ANALYTICS_DIMENSION_TYPES = ['boolean', 'string', 'number', 'enum'] as const;

/** One of {@link ANALYTICS_DIMENSION_TYPES}. */
export type AnalyticsDimensionType = (typeof ANALYTICS_DIMENSION_TYPES)[number];

/** A dimension as we SEND it. The dialer runtime's `analyticsDimensionSchema` requires a
 *  non-empty key and description, so the assemblers (`toValidDimensions`) must
 *  produce exactly this — keep it strict. */
export interface AnalyticsDimension {
  key: string;
  description: string;
  type: AnalyticsDimensionType;
  options?: string[];
}

/** A dimension as the dialer runtime ECHOES it back, which is not the same guarantee: the
 *  dimension list is stored as JSONB and rows written before the current schema
 *  (or by an import) can carry NULLs where a send would require a string. Read
 *  paths use this shape so the compiler makes them normalize — the editor's
 *  `.trim()` on a NULL description is the crash this type exists to prevent. */
export interface StoredAnalyticsDimension {
  key: string | null;
  description: string | null;
  type: AnalyticsDimensionType;
  options?: (string | null)[] | null;
}

export interface CallAnalysisResult {
  _meta?: {
    model?: string;
    provider?: string;
    /** `transcript` or `audio`: whether the recording itself was analysed. */
    input?: 'transcript' | 'audio';
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
