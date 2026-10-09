// Only the analytics dimension types the analysis service, prompt builder and
// call-analysis profiles import. There is no prompt template model (no AI calls).

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
