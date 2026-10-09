/**
 * Call-analysis profiles — the dialer's reusable "what we measure" definition.
 *
 * An agency (browser→PSTN agent) call has no prompt template, so it has nowhere
 * else to hang the operator-defined analysis dimensions. A profile is that,
 * standalone: nameable, reusable, defaultable per account, selectable per call.
 *
 * Mirrors the `call_analysis_profiles` row, reached through the
 * `/proxy/call-analysis-profiles` passthrough (capability `calls.dialer.analytics`).
 */

// One shared `analyticsDimensionSchema` governs the dimension shape, so reuse the
// existing type (in `./shared`) rather than declaring a near-duplicate that could
// drift.
import type { AnalyticsDimension, StoredAnalyticsDimension } from './shared';

export type { AnalyticsDimension, StoredAnalyticsDimension };

export interface CallAnalysisProfile {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  description: string | null;
  /** Free-text business context prepended to the analysis prompt. */
  context: string | null;
  custom_dimensions: StoredAnalyticsDimension[];
  /** Optional BCP-47 transcription hint. `null` = auto-detect. */
  language_hint: string | null;
  is_default: boolean;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CallAnalysisProfilesListResponse {
  profiles: CallAnalysisProfile[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateCallAnalysisProfileInput {
  name: string;
  description?: string;
  context?: string;
  custom_dimensions?: AnalyticsDimension[];
  language_hint?: string;
  is_default?: boolean;
}

/**
 * Copy-on-write update (mirrors prompt templates): every field optional, omitted
 * fields carry forward from the superseded version. `name` is part of the logical
 * identity and is never changed by an update.
 */
export interface UpdateCallAnalysisProfileInput {
  description?: string;
  context?: string;
  custom_dimensions?: AnalyticsDimension[];
  language_hint?: string;
  is_default?: boolean;
}

/** Upper bound on dimensions per profile — matches the dialer runtime's validator (max 20). */
export const MAX_ANALYSIS_DIMENSIONS = 20;
