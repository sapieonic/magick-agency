// The carrier catalogue: every carrier, listed once, with what it declares about itself
// (docs/carriers.md §2.2). Built from each carrier's own `<carrier>/<carrier>.capabilities.ts`,
// which loads no codecs and no adapters, so the agency repository's projections, the dialer's
// `provider` metric label and the route code can read it without loading the carrier modules
// and the codec tables they build at load (`test/unit/db/projections-import-graph.test.ts`).
//
// Every rule that asks which carrier ACCOUNT a campaign, number or call may be on reads the
// mode helpers below (CR1), never a carrier's name and never whether a credential spec exists.
// `test/unit/telephony/carrier-conformance.test.ts` holds every per-carrier list (modules,
// adapters, credential specs, recording access) equal to this one (CR14).
import type { AppConfig } from '../config/index.js';
import { plivoCapabilities } from './plivo/plivo.capabilities.js';
import { voicelinkCapabilities } from './voicelink/voicelink.capabilities.js';

/** The env-only carrier settings (`config.telephony`). */
export type TelephonyConfig = AppConfig['telephony'];

/** What a carrier declares about itself, without its codec or adapters (`CarrierModule` repeats `cancelsRinging`). */
export interface CarrierDescriptor {
  /** The provider name: `agency_calls.provider`, `telephony_providers.name`, its carrier module's name. */
  readonly name: string;
  /** Whether a hang-up stops a dial still ringing (`CarrierModule.cancelsRinging`, SP3). */
  readonly cancelsRinging: boolean;
  /**
   * The account modes it supports (CR1). `service`: the service's own account, configured from
   * env, the row's credential null. `tenant`: a tenant's own account, the row's credential set.
   */
  readonly accounts: { readonly service: boolean; readonly tenant: boolean };
  /** Whether a tenant account on it takes inbound calls (docs/inbound.md; CR11). */
  readonly inbound: boolean;
  /**
   * Whether a recording of a call on the service's account goes to the client as its raw URL
   * (`utils/recording-url-resolver.ts`). Never for a call pinned to a credential (CR12).
   */
  readonly serviceRecordingsArePublic: boolean;
  /**
   * The carrier's webhook namespace, from env only, never from tenant data (the SSRF rule in
   * `factory.ts`). Read by `core/webhook-url-builder.ts`.
   */
  webhookBaseUrl(telephony: TelephonyConfig): string;
}

const CATALOG: ReadonlyMap<string, CarrierDescriptor> = new Map(
  [voicelinkCapabilities, plivoCapabilities].map((c) => [c.name, c]),
);

/** The descriptor for a provider name, or undefined for a name no carrier answers to. */
export function findCarrier(provider: string | null | undefined): CarrierDescriptor | undefined {
  return provider ? CATALOG.get(provider) : undefined;
}

/**
 * Every carrier in the catalogue: what the conformance test holds every registry equal to, and
 * the whole vocabulary of the dialer's `provider` metric label besides `other`
 * (`providerLabel` in `agency/agency-dialer.ts`), so a carrier added here is a new label value.
 */
export function carrierNames(): string[] {
  return [...CATALOG.keys()];
}

/** May a campaign, number or call on this carrier have a null credential (the service's own account)? */
export function carrierHasServiceAccount(provider: string | null | undefined): boolean {
  return findCarrier(provider)?.accounts.service === true;
}

/** May a campaign, number or call on this carrier be pinned to a tenant credential? */
export function carrierTakesTenantAccounts(provider: string | null | undefined): boolean {
  return findCarrier(provider)?.accounts.tenant === true;
}

/** Whether a tenant account on this carrier takes inbound calls (CR11). */
export function carrierSupportsInbound(provider: string | null | undefined): boolean {
  return findCarrier(provider)?.inbound === true;
}

/**
 * The account-mode check for one row (CR1): a null credential needs a service account, a set
 * one needs tenant accounts. An unknown carrier allows neither.
 */
export function carrierAccountModeAllowed(provider: string | null | undefined, credentialId: string | null): boolean {
  return credentialId === null ? carrierHasServiceAccount(provider) : carrierTakesTenantAccounts(provider);
}

/**
 * Whether a hang-up stops a call on this carrier ringing. Fails closed, like
 * `canCancelRinging`: no provider (the leg is not placed yet) or a name no carrier answers to
 * reads as unable, so the agent is warned rather than misled.
 */
export function carrierCancelsRinging(provider: string | null | undefined): boolean {
  return findCarrier(provider)?.cancelsRinging === true;
}
