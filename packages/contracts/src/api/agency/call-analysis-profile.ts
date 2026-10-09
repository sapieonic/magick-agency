/**
 * Call-analysis profiles — the dialer's reusable "what we measure" definition.
 *
 * A dialer (browser→PSTN human) call has no prompt template, so it has nowhere
 * to hang the operator-defined analysis dimensions that AI calls carry on
 * `prompt_templates.analytics_config`. A profile is that, standalone: nameable,
 * reusable, defaultable per account, selectable per call.
 *
 * Mirrors core's `call_analysis_profiles` row (magic-voice-core
 * `src/db/models/call-analysis-profile.model.ts`), reached through master's
 * `/proxy/call-analysis-profiles` passthrough (capability `calls.dialer.analytics`,
 * RBAC `proxy.prompts.read` / `.write`).
 */

// The dimension shape is IDENTICAL to a prompt template's — core lifted one
// shared `analyticsDimensionSchema` for both — so reuse the existing type rather
// than declaring a near-duplicate that could drift.
// PORT NOTE (magick-agency): `./prompt` is not ported; the two dimension types
// are carried verbatim in `./shared`.
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

/** Upper bound on dimensions per profile — matches core's validator (max 20). */
export const MAX_ANALYSIS_DIMENSIONS = 20;
