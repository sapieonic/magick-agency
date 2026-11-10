// The process's one credential service, built from config on first use (decision B19).
import { config } from '../../config/index.js';
import { keyringEntries } from '../../config/blocks/voice.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { getPool } from '@magick-agency/db';
import { CredentialSealer, EnvKeyringWrapper } from './credential-sealer.js';
import { TelephonyCredentialService } from './credential-service.js';
import { TelephonyInboundService } from './inbound-service.js';
import { agencyInboundCallRepository, agencyInboundRouteRepository } from '../../db/repositories/agency.repository.js';
import { createPlivoAdapter } from '../plivo/plivo.adapter.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';

let service: TelephonyCredentialService | null = null;
let inboundService: TelephonyInboundService | null = null;

/**
 * The sealer for the configured keyring, or null when `TELEPHONY_CREDENTIAL_KEYS` has no
 * entries. "No entries" is the config schema's own test (`keyringEntries`), so a blank,
 * whitespace or comma-only value the schema accepts as "store off" is off here too,
 * instead of reaching `EnvKeyringWrapper` and throwing on the first call (which
 * `startVoice` makes unconditionally).
 */
export function buildSealerFromConfig(cfg: { keyring: string; activeKeyId: string }): CredentialSealer | null {
  if (keyringEntries(cfg.keyring).length === 0) return null;
  return new CredentialSealer(new EnvKeyringWrapper(cfg.keyring, cfg.activeKeyId));
}

export function getTelephonyCredentialService(): TelephonyCredentialService {
  if (!service) {
    service = new TelephonyCredentialService({
      repo: telephonyCredentialRepository,
      tenants: tenantRepository,
      sealer: buildSealerFromConfig(config.telephonyCredentials),
      numbers: phoneNumberRepository,
    });
  }
  return service;
}

export function setTelephonyCredentialServiceForTests(s: TelephonyCredentialService | null): void {
  service = s;
  inboundService = null;
}

/**
 * The process's inbound service (`inbound-service.ts`): the credential's Plivo Application and
 * the numbers' links, on the credential service above (it opens the secrets), the Plivo adapter
 * (fixed host; tests reach the mock carrier with `setPlivoTransportForTests`) and the env's
 * public callback base, read per call.
 */
export function getTelephonyInboundService(): TelephonyInboundService {
  if (!inboundService) {
    inboundService = new TelephonyInboundService({
      credentials: getTelephonyCredentialService(),
      repo: telephonyCredentialRepository,
      numbers: phoneNumberRepository,
      routes: agencyInboundRouteRepository,
      calls: agencyInboundCallRepository,
      carrierFor: (credential) => createPlivoAdapter(credential, config),
      settings: () => ({
        webhookBaseUrl: config.telephony.plivo.webhookBaseUrl,
        inboundFallbackAnswerUrl: config.telephony.plivo.inboundFallbackAnswerUrl,
        mediaWorkers: config.processes.mediaWorkers,
      }),
      audit: (entry) => { void recordSuperAdminAudit(entry); },
      pool: getPool(),
    });
  }
  return inboundService;
}

export { TelephonyCredentialService, CredentialUnavailableError, ROTATION_GRACE_SECONDS } from './credential-service.js';
export { TelephonyInboundService } from './inbound-service.js';
export type { ResolvedCredential, ResolvePurpose } from './credential-service.js';
