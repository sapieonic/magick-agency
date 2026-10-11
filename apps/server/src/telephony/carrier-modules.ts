// The carrier-module registry: every carrier the bridge can carry a call on. Adding a
// carrier means adding its module here and its adapter in `factory.ts`; the
// conformance test (`test/unit/telephony/carrier-modules.test.ts`) holds the two lists
// equal.
import type { CarrierModule } from './carrier-module.js';
import { voicelinkCarrier } from './voicelink/voicelink.media.js';

const MODULES: ReadonlyMap<string, CarrierModule> = new Map(
  [voicelinkCarrier].map((m) => [m.name, m]),
);

/** The module for a provider name, or undefined for a name no carrier answers to. */
export function findCarrierModule(provider: string): CarrierModule | undefined {
  return MODULES.get(provider);
}

/** Every registered carrier name. */
export function carrierModuleNames(): string[] {
  return [...MODULES.keys()];
}
