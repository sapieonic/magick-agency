// Plivo's codec-free capability declaration: what a reader may know of the carrier without
// loading its media module and the codec tables it builds at load. The carrier module reads
// it (`plivo.media.ts`); the codec-free registry collects it (`../carrier-ringing.ts`).
import type { CarrierCapabilities } from '../carrier-ringing.js';

export const plivoCapabilities: CarrierCapabilities = {
  name: 'plivo',
  // A ringing dial is cancelled by its request id (`DELETE /Request/{id}/`).
  cancelsRinging: true,
};
