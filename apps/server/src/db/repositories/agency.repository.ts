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
export {
  AGENT_CALLER_ID_NUMBER_CONSTRAINT,
  AgencyAgentCallerIdRepository,
  agencyAgentCallerIdRepository,
} from './agency/agent-caller-id.repository.js';
export type { AgentCallerIdRow, AgentCallerIdSetOutcome } from './agency/agent-caller-id.repository.js';
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
export { agentAbsent } from './agency/assignment-reads.repository.js';
export {
  AgencyInsightsReadRepository,
  agencyInsightsReadRepository,
  abandonmentWindowStatement,
  allocationCountersStatement,
  allocationStatement,
  contactsOnDncStatement,
  dialPaceStatement,
  dncMarkedStatement,
  softphoneCallsStatement,
  INSIGHTS_UPLOADS_LIMIT,
  rosterStatement,
} from './agency/insights-reads.repository.js';
export type {
  AllocationCountsInput,
  DialPace,
  InsightsStatement,
  InsightsUploadRow,
  OwnerAttemptCounters,
  OwnerCounts,
  RosterCounts,
  RosterCountsInput,
} from './agency/insights-reads.repository.js';
export {
  attemptedSql,
  pendingCallbackSql,
  ROSTER_BUCKETS,
  rosterBucketPredicates,
  suppressedDncSql,
  suppressedInvalidSql,
  suppressedOtherSql,
  waitingCallbackSql,
  waitingDueNowSql,
  waitingRetrySql,
  waitingSql,
} from './agency/insights-sql.js';
export type { RosterBucket } from './agency/insights-sql.js';
export { manualCallRequiresDisposition, projectManualCallRow } from './agency/projections.js';
export type { AgencyManualCallJoinedRow } from './agency/projections.js';
// The drill-down predicates: one definition of each roster bucket and attempt slice, read by
// the Contacts / Call attempts lists and their totals and by the insights reads.
export {
  agentManualAttemptSql,
  agentReopenedAttemptSql,
  attemptAgentUserSql,
  attemptedContactSql,
  dialedRangeSql,
  placedDialSql,
  redialAttemptSql,
  waitingContactSql,
} from './agency/drilldown-sql.js';
export type { ContactWaitingBucket } from './agency/drilldown-sql.js';
export { contactListFilterConditions } from './agency/query-builders.js';
export {
  AgencyInsightsRollupRepository,
  agencyInsightsRollupRepository,
} from './agency/insights-rollup.repository.js';
export type { InsightsRollupBatchResult } from './agency/insights-rollup.repository.js';
export { INSIGHTS_BUCKET_MINUTES } from './agency/insights-rollup-sql.js';
export type {
  InsightsActivityAgentRow,
  InsightsActivityRollup,
  InsightsMeasures,
  InsightsRangeQuery,
  InsightsTrendRow,
  InsightsTrends,
} from './agency/insights-rollup-reads.js';
export type {
  InsightsAgentStateRow,
  InsightsCallbackClass,
  InsightsCallbackTiming,
} from './agency/insights-range-reads.js';
