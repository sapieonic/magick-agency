// Whether a hang-up stops a call on a carrier ringing, per carrier: the one statement of each
// carrier module's `cancelsRinging` (`CarrierModule.cancelsRinging`; each module reads its own
// entry). Its own module, codec-free and import-free, so a reader that needs only this (the
// agency repository's manual-call projection) does not load the carrier modules and the codec
// tables they build at load. `carrier-modules.test.ts` holds it equal to the registry.

const CANCELS_RINGING: Readonly<Record<string, boolean>> = {
  // VoiceLink has no hangup endpoint for a leg still ringing: it rings on (SP3).
  voicelink: false,
  // Plivo cancels a ringing dial by its request id (`DELETE /Request/{id}/`).
  plivo: true,
};

/**
 * The declaration for a carrier module named `provider` (false for a name with none). Each
 * carrier module sets its `cancelsRinging` from this.
 */
export function declaredCancelsRinging(provider: string): boolean {
  return Object.hasOwn(CANCELS_RINGING, provider) && CANCELS_RINGING[provider] === true;
}

/**
 * Whether a hang-up stops a call on this carrier ringing. Fails closed, like
 * `canCancelRinging`: no provider (the leg is not placed yet) or a name no carrier answers to
 * reads as unable, so the agent is warned rather than misled.
 */
export function carrierCancelsRinging(provider: string | null | undefined): boolean {
  return provider ? declaredCancelsRinging(provider) : false;
}

/** Every carrier with a declaration, for the conformance test. */
export function carrierRingingDeclarations(): string[] {
  return Object.keys(CANCELS_RINGING);
}
