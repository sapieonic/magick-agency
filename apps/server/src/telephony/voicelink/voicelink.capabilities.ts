// VoiceLink's codec-free catalogue entry: what a reader may know of the carrier without
// loading its media module and the codec tables it builds at load. The carrier module reads
// it (`voicelink.media.ts`); the catalogue collects it (`../carrier-catalog.ts`).
import type { CarrierDescriptor } from '../carrier-catalog.js';

export const voicelinkCapabilities: CarrierDescriptor = {
  name: 'voicelink',
  // No hangup endpoint for a leg still ringing: it rings on (SP3).
  cancelsRinging: false,
  // The service's own account only, configured from env (B18). Tenant accounts are
  // docs/carriers.md step 2 (CR2–CR5).
  accounts: { service: true, tenant: false },
  inbound: false,
  // Public https MP3s needing no auth, which the viewer's browser can reach where our egress
  // cannot (`utils/recording-url-resolver.ts`).
  serviceRecordingsArePublic: true,
  webhookBaseUrl: (telephony) => telephony.voicelink.webhookBaseUrl,
};
