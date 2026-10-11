// The process's one credential service, built from config on first use (decision B19).
import { config } from '../../config/index.js';
import { keyringEntries } from '../../config/blocks/voice.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { CredentialSealer, EnvKeyringWrapper } from './credential-sealer.js';
import { TelephonyCredentialService } from './credential-service.js';

let service: TelephonyCredentialService | null = null;

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
    });
  }
  return service;
}

export function setTelephonyCredentialServiceForTests(s: TelephonyCredentialService | null): void {
  service = s;
}

export { TelephonyCredentialService, CredentialUnavailableError, ROTATION_GRACE_SECONDS } from './credential-service.js';
export type { ResolvedCredential, ResolvePurpose } from './credential-service.js';
