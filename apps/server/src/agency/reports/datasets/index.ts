/**
 * The dataset builder for each report kind. The builders themselves are in this folder
 * (`agent.ts`, `campaign.ts`, `account.ts`); the assembler looks a kind up here and nowhere else.
 */
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import type { ReportDatasetBuilder } from './types.js';

export * from './types.js';

function notBuilt(kind: ReportKind): ReportDatasetBuilder {
  return async () => {
    throw new Error(`report dataset builder for kind '${kind}' is not built yet`);
  };
}

/** One builder per kind; a `Record` over the union so a new kind without a builder fails `tsc`. */
export const REPORT_DATASET_BUILDERS: Record<ReportKind, ReportDatasetBuilder> = {
  agent: notBuilt('agent'),
  campaign: notBuilt('campaign'),
  account: notBuilt('account'),
};
