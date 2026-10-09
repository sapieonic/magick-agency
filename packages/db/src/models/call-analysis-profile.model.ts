// ─── Call Analysis Profiles ─────────────────────────────────────────────
//
// An agency call (`agency_calls`, a browser→PSTN agent leg) has no prompt
// template, so it has nowhere else to hang the operator-defined analysis
// dimensions. A profile is the first-class, reusable, defaultable answer:
// "what we measure", selectable per call and versionable.

// Reuse AnalyticsDimension from the prompt model — same shape, same validator bounds.
import type { AnalyticsDimension } from './prompt.model.js';

export interface CallAnalysisProfileRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  description: string | null;
  /** Free-text business context prepended to the analysis prompt. */
  context: string | null;
  custom_dimensions: AnalyticsDimension[];
  /** Optional BCP-47 transcription hint. NULL = auto-detect. */
  language_hint: string | null;
  is_default: boolean;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCallAnalysisProfileInput {
  tenant_id: string;
  account_id: string;
  name: string;
  description?: string | null;
  context?: string | null;
  custom_dimensions?: AnalyticsDimension[];
  language_hint?: string | null;
  is_default?: boolean;
}

/**
 * Copy-on-write update input (mirrors prompt templates). Every field is optional;
 * omitted fields carry forward from the superseded version. tenant/account/name are
 * the logical identity and are never changed by an update.
 */
export interface UpdateCallAnalysisProfileInput {
  description?: string | null;
  context?: string | null;
  custom_dimensions?: AnalyticsDimension[];
  language_hint?: string | null;
  is_default?: boolean;
}
