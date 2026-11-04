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
export type {
  AgencyAgentClaim,
  AgencyAgentQueueProbe,
  AgencyAgentQueueProbeRow,
  AgencyCallbackFallbackMove,
  AgencyOwnerClaimMode,
  AgencyPoolQueueProbe,
} from './agency/contact.repository.js';
export { AgencyAttemptRepository, agencyAttemptRepository } from './agency/attempt.repository.js';
export {
  AGENT_RETRY_SKIPPED_LIST_MAX,
  AgencyAgentRetryRepository,
  agencyAgentRetryRepository,
} from './agency/agent-retry.repository.js';
export type { AgentDialClaim, AgentRetryReopenResult, AgentRetrySettings } from './agency/agent-retry.repository.js';
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
export type { AgencyLiveAttemptStateRow, AgencyLiveManualCallStateRow } from './agency/fleet-metrics.repository.js';
export { AgencyAgentStatsRepository, agencyAgentStatsRepository } from './agency/agent-stats.repository.js';
export {
  AgencyInsightsPacingRepository,
  agencyInsightsPacingRepository,
  PACING_HISTORY_FIELDS,
  PACING_HISTORY_MAX_EPISODES,
  PACING_IDLE_FIELD,
} from './agency/insights-pacing.repository.js';
export type {
  AgencyPacingHistory,
  AgencyStallReason,
  PacingHistoryField,
  PacingMinuteRow,
} from './agency/insights-pacing.repository.js';
export { occupancyIntervalsCtes } from './agency/sql-fragments.js';
export { AgencyAssignmentRepository, agencyAssignmentRepository, planCtes } from './agency/assignment.repository.js';
export type {
  AssignmentCampaignScope,
  AssignmentCommitOutcome,
  UnstaffReturn,
} from './agency/assignment.repository.js';
export {
  AgencyAssignmentReadRepository,
  agencyAssignmentReadRepository,
  emptyBucketCounts,
  heroColumns,
} from './agency/assignment-reads.repository.js';
export type { MyContactsTally, OwnerTally, ProgressRaw } from './agency/assignment-reads.repository.js';
export { manualCallRequiresDisposition, projectManualCallRow } from './agency/projections.js';
export type { AgencyManualCallJoinedRow } from './agency/projections.js';
