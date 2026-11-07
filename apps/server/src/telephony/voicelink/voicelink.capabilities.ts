// VoiceLink's codec-free capability declaration: what a reader may know of the carrier
// without loading its media module and the codec tables it builds at load. The carrier
// module reads it (`voicelink.media.ts`); the codec-free registry collects it
// (`../carrier-ringing.ts`).
import type { CarrierCapabilities } from '../carrier-ringing.js';

export const voicelinkCapabilities: CarrierCapabilities = {
  name: 'voicelink',
  // No hangup endpoint for a leg still ringing: it rings on (SP3).
  cancelsRinging: false,
};
