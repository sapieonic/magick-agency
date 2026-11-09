/**
 * The definition keys each kind's dataset carries live in the contracts
 * (`REPORT_DEFINITION_KEYS`, the server's print order). The workbook looks a figure's definition
 * up by one of them, so a key the kind never carries fails `tsc` instead of leaving the Summary's
 * Definition cell blank. The test fixtures carry the server's definitions, and
 * `test/definitions.test.ts` holds them to the list.
 */
import {
  REPORT_DEFINITION_KEYS,
  REPORT_SUPERVISOR_ONLY_AGENT_DEFINITION_KEYS,
  type ReportDataset,
  type ReportDefinitionKey,
} from '@magick-agency/contracts/reports';

export const DEFINITION_KEYS = REPORT_DEFINITION_KEYS;
export const SUPERVISOR_ONLY_AGENT_KEYS = REPORT_SUPERVISOR_ONLY_AGENT_DEFINITION_KEYS;

/** A definition key the dataset of kind `K` carries. */
export type DefinitionKey<K extends ReportDataset['kind']> = ReportDefinitionKey<K>;

/** The definition's text for one of the dataset's keys; undefined when this copy leaves it out. */
export function definitionText<D extends ReportDataset>(d: D, key: DefinitionKey<D['kind']>): string | undefined {
  return d.definitions.find((x) => x.key === key)?.text;
}
