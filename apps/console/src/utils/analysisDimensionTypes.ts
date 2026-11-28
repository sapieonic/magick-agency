import type { AnalyticsDimensionType } from '@magick-agency/contracts/api/agency/shared';

/**
 * A custom dimension's answer type in plain words. The raw `string|boolean|number|enum` tokens
 * are never shown: "Text / Yes / No / Number / Choices" is what a user understands. One list for
 * the analysis-profile editor and Export with fields, so both say a type the same way. The key
 * order is the editor's type picker's order.
 */
export const DIMENSION_TYPE_LABELS: Readonly<Record<AnalyticsDimensionType, string>> = {
  string: 'Text',
  boolean: 'Yes / No',
  number: 'Number',
  enum: 'Choices',
};
