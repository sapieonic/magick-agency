/**
 * The dataset builder for each report kind. The builders themselves are in this folder
 * (`agent.ts`, `campaign.ts`, `account.ts`); the assembler looks a kind up here and nowhere else.
 */
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { buildAccountReport } from './account.js';
import { buildAgentReview } from './agent.js';
import { buildCampaignReport } from './campaign.js';
import type { ReportDatasetBuilder } from './types.js';

export * from './types.js';
export { buildAccountReport, buildAgentReview, buildCampaignReport };

/** One builder per kind; a `Record` over the union so a new kind without a builder fails `tsc`. */
export const REPORT_DATASET_BUILDERS: Record<ReportKind, ReportDatasetBuilder> = {
  agent: buildAgentReview,
  campaign: buildCampaignReport,
  account: buildAccountReport,
};
