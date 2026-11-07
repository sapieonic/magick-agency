// The carrier-module registry: every carrier the bridge can carry a call on. Adding a
// carrier means adding its module here and its adapter in `factory.ts` (the
// `instantiate` switch, or `BYOC_ADAPTERS` for a tenant-credential carrier); the
// conformance test (`test/unit/telephony/carrier-modules.test.ts`) holds the lists
// equal.
import type { CarrierModule } from './carrier-module.js';
import { voicelinkCarrier } from './voicelink/voicelink.media.js';
import { plivoCarrier } from './plivo/plivo.media.js';

const MODULES: ReadonlyMap<string, CarrierModule> = new Map(
  [voicelinkCarrier, plivoCarrier].map((m) => [m.name, m]),
);

/** The module for a provider name, or undefined for a name no carrier answers to. */
export function findCarrierModule(provider: string): CarrierModule | undefined {
  return MODULES.get(provider);
}

/**
 * Whether a hang-up stops a call on this carrier ringing ({@link CarrierModule.cancelsRinging}),
 * from the codec-free declaration every module reads (`carrier-ringing.ts`).
 */
export { carrierCancelsRinging } from './carrier-ringing.js';

/** Every registered carrier name. */
export function carrierModuleNames(): string[] {
  return [...MODULES.keys()];
}
