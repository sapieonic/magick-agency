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
  // A tenant's recordings need its credential (Basic auth, B21), so they are always fetched by
  // the recording proxy, never handed to the viewer.
  recordingsArePublic: false,
  webhookBaseUrl: (telephony) => telephony.plivo.webhookBaseUrl,
};
