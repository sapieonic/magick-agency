export type ConcurrencyAllocationMode = 'legacy_total' | 'provider_breakdown';

export interface AccountSettingsRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  max_concurrent_calls: number;
  /** Legacy flat allocation or an explicit provider-level breakdown. */
  concurrency_allocation_mode: ConcurrencyAllocationMode;
  /** Optimistic-lock version for concurrency allocation changes. */
  concurrency_allocation_version: number;
  /** Pre-resolved per-account toggle for post-call analysis. Null = inherit the env default. */
  analyze_calls: boolean | null;
  /** Pre-resolved per-account ceiling on call recording. Null = inherit the env default. */
  allow_recording: boolean | null;
  /**
   * Per-account cap on a bridged call's length, in seconds. Null = the process
   * default applies. This replaces the former global
   * `webrtc_max_duration_seconds` feature flag.
   */
  webrtc_max_duration_seconds: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderConcurrencyAllocationRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  telephony_provider: string;
  max_concurrent_calls: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderConcurrencyAllocation {
  provider: string;
  max_concurrent_calls: number;
}

export interface AccountConcurrencyAllocation {
  tenant_id: string;
  account_id: string;
  mode: ConcurrencyAllocationMode;
  version: number;
  total_concurrency: number;
  providers: ProviderConcurrencyAllocation[];
}

export interface UpsertAccountSettingsInput {
  tenant_id: string;
  account_id: string;
  max_concurrent_calls: number;
  /** Omit (undefined) to preserve the existing value on update; null/boolean sets it. */
  analyze_calls?: boolean | null;
  /** Omit (undefined) to preserve the existing value on update; null/boolean sets it. */
  allow_recording?: boolean | null;
}
