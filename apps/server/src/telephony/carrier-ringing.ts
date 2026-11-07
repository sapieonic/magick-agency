// Whether a hang-up stops a call on a carrier ringing, per carrier: the codec-free registry of
// the capability each carrier declares in its own folder (`<carrier>/<carrier>.capabilities.ts`;
// each carrier module reads its own declaration for `CarrierModule.cancelsRinging`). Codec-free
// and free of the carrier modules, so a reader that needs only this (the agency repository's
// manual-call projection) does not load the carrier modules and the codec tables they build at
// load. `carrier-modules.test.ts` holds it equal to the registry.
import { plivoCapabilities } from './plivo/plivo.capabilities.js';
import { voicelinkCapabilities } from './voicelink/voicelink.capabilities.js';

/** What a carrier declares about itself without its codec (`CarrierModule` repeats it). */
export interface CarrierCapabilities {
  /** The provider name its carrier module answers to. */
  readonly name: string;
  /** Whether a hang-up stops a dial still ringing (`CarrierModule.cancelsRinging`, SP3). */
  readonly cancelsRinging: boolean;
}

const DECLARATIONS: ReadonlyMap<string, CarrierCapabilities> = new Map(
  [voicelinkCapabilities, plivoCapabilities].map((c) => [c.name, c]),
);

/**
 * Whether a hang-up stops a call on this carrier ringing. Fails closed, like
 * `canCancelRinging`: no provider (the leg is not placed yet) or a name no carrier answers to
 * reads as unable, so the agent is warned rather than misled.
 */
export function carrierCancelsRinging(provider: string | null | undefined): boolean {
  return provider ? DECLARATIONS.get(provider)?.cancelsRinging === true : false;
}

/** Every carrier with a declaration, for the conformance test. */
export function carrierRingingDeclarations(): string[] {
  return [...DECLARATIONS.keys()];
}
