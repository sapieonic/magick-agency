/**
 * The definition keys each kind's dataset carries, as the server writes them
 * (`apps/server/src/agency/reports/datasets/definitions.ts`). The contracts type
 * `ReportDefinition.key` as a plain string, so the list is mirrored here: the workbook looks a
 * figure's definition up by one of these keys, and a key the kind never carries fails `tsc`
 * instead of leaving the Summary's Definition cell blank. The test fixtures carry the server's
 * definitions, and `test/definitions.test.ts` holds them to this list.
 */
import type { ReportDataset } from '@magick-agency/contracts/reports';

/** Every key per kind, in the server's print order. */
export const DEFINITION_KEYS = {
  agent: [
    'dials',
    'first_dials',
    'connected',
    'connect_rate',
    'successes',
    'success_rate',
    'talk_time',
    'wrapup_time',
    'aht',
    'outcome_talk',
    'logged_in_time',
    'occupancy',
    'on_call_share',
    'on_call_share_excl_break',
    'days_worked',
    'first_in_last_out',
    'drops',
    'callbacks_booked',
    'callbacks_on_time',
    'callbacks_late',
    'callbacks_missed',
    'callbacks_pending',
    'redials',
    'agent_retries',
    'overrides',
    'dnc_marked',
    'softphone_calls',
    // The supervisor's copy only.
    'floor_comparison',
    'sentiment',
  ],
  campaign: [
    'dials',
    'first_dials',
    'connected',
    'conversations',
    'connect_rate',
    'success_rate',
    'abandonment_rate',
    'talk_time',
    'wrapup_time',
    'callbacks_booked',
    'callbacks_on_time',
    'callbacks_late',
    'callbacks_missed',
    'callbacks_pending',
    'agents_online_peak',
    'best_hours',
    'stalls',
    'predial_blocks',
    'recording_share',
  ],
  account: [
    'dials',
    'first_dials',
    'connected',
    'conversations',
    'connect_rate',
    'success_rate',
    'abandonment_rate',
    'talk_time',
    'wrapup_time',
    'callbacks_booked',
    'predial_blocks',
    'recording_share',
    'totals',
    'agent_rates',
    'occupancy',
    'floor_comparison',
  ],
} as const satisfies Record<ReportDataset['kind'], readonly string[]>;

/** The keys the agent review leaves out of the `self` audience's copy. */
export const SUPERVISOR_ONLY_AGENT_KEYS = ['floor_comparison', 'sentiment'] as const satisfies readonly DefinitionKey<'agent'>[];

/** A definition key the dataset of kind `K` carries. */
export type DefinitionKey<K extends ReportDataset['kind']> = (typeof DEFINITION_KEYS)[K][number];

/** The definition's text for one of the dataset's keys; undefined when this copy leaves it out. */
export function definitionText<D extends ReportDataset>(d: D, key: DefinitionKey<D['kind']>): string | undefined {
  return d.definitions.find((x) => x.key === key)?.text;
}
