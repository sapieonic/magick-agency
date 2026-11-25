// The carrier-module registry: every carrier the bridge can carry a call on. A carrier
// registers one line here, beside its catalogue entry (`carrier-catalog.ts`) and the other
// pieces its account modes need (docs/carriers.md §2.3, CR14);
// `test/unit/telephony/carrier-conformance.test.ts` holds every list equal to the catalogue.
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
 * from the codec-free carrier catalogue (`carrier-catalog.ts`).
 */
export { carrierCancelsRinging } from './carrier-catalog.js';

/** Every registered carrier name. */
export function carrierModuleNames(): string[] {
  return [...MODULES.keys()];
}
