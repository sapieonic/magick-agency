// PORT NOTE (magick-agency): a SUBSET of core `src/db/models/prompt.model.ts`
// (v1.123.2, lines 1-12), verbatim: only the analytics dimension types the
// analysis service, prompt builder and call-analysis profiles import. The prompt
// template model itself (AI calls) is not carried.

export type AnalyticsDimensionType = 'boolean' | 'string' | 'number' | 'enum';

export interface AnalyticsDimension {
  key: string;
  description: string;
  type: AnalyticsDimensionType;
  options?: string[];
}

export interface AnalyticsConfig {
  custom_dimensions: AnalyticsDimension[];
}
