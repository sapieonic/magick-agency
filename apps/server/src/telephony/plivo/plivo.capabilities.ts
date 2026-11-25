// Plivo's codec-free catalogue entry: what a reader may know of the carrier without loading
// its media module and the codec tables it builds at load. The carrier module reads it
// (`plivo.media.ts`); the catalogue collects it (`../carrier-catalog.ts`).
import type { CarrierDescriptor } from '../carrier-catalog.js';

export const plivoCapabilities: CarrierDescriptor = {
  name: 'plivo',
  // A ringing dial is cancelled by its request id (`DELETE /Request/{id}/`).
  cancelsRinging: true,
  // Tenants' own accounts only (B18): the service has no Plivo account.
  accounts: { service: false, tenant: true },
  // The inbound Application on a tenant's account (docs/inbound.md).
  inbound: true,
  // No service account, so no service recording either; a tenant's recordings always go
  // through the recording proxy on its credential (B21).
  serviceRecordingsArePublic: false,
  webhookBaseUrl: (telephony) => telephony.plivo.webhookBaseUrl,
};
