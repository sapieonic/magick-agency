/**
 * The agency repository: every read and write the dialer runtime and the campaign
 * management routes make against the `agency_*` tables.
 *
 * A barrel over `./agency/`, one file per repository class plus the leaves they
 * share (`sql-fragments.ts`, `query-builders.ts`, `projections.ts`). Every caller
 * outside that folder imports THIS path, and the unit suites `vi.mock` it: a mock
 * of this module replaces the singletons and classes every caller reaches. Files
 * inside the folder never import this barrel or each other's classes.
 */
export { AgencyCampaignRepository, agencyCampaignRepository } from './agency/campaign.repository.js';
export { AgencyContactRepository, agencyContactRepository } from './agency/contact.repository.js';
export { AgencyAttemptRepository, agencyAttemptRepository } from './agency/attempt.repository.js';
export { AgencyAgentSessionRepository, agencyAgentSessionRepository } from './agency/agent-session.repository.js';
export type { AgencySoftphoneJoinResult } from './agency/agent-session.repository.js';
export { AgencyManualCallRepository, agencyManualCallRepository } from './agency/manual-call.repository.js';
export type {
  AgencyManualCallAdvanceState,
  AgencyManualCallCreateInput,
  AgencyManualCallDispositionRefusal,
  AgencyManualCallListFilters,
  AgencyManualCallListRow,
} from './agency/manual-call.repository.js';
export {
  AgencySoftphoneSettingsRepository,
  agencySoftphoneSettingsRepository,
  SOFTPHONE_SETTINGS_DEFAULTS,
  SoftphoneSettingsInvalidError,
  validateSoftphoneSettings,
} from './agency/softphone-settings.repository.js';
export type { SoftphoneSettingsIssue } from './agency/softphone-settings.repository.js';
export {
  AgencyAbandonmentRepository,
  AgencyLiveConcurrencyRepository,
  agencyAbandonmentRepository,
  agencyLiveConcurrencyRepository,
} from './agency/fleet-metrics.repository.js';
export type { AgencyLiveAttemptStateRow } from './agency/fleet-metrics.repository.js';
export { AgencyAgentStatsRepository, agencyAgentStatsRepository } from './agency/agent-stats.repository.js';
export { occupancyIntervalsCtes } from './agency/sql-fragments.js';
export { manualCallRequiresDisposition, projectManualCallRow } from './agency/projections.js';
export type { AgencyManualCallJoinedRow } from './agency/projections.js';
