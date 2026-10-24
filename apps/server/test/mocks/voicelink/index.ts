// The mock VoiceLink carrier (see `mock-carrier.ts` for why it is Node-native).
export { MockVoicelinkCarrier, type CarrierFault, type CarrierRoute, type MockCarrierOptions, type RecordedRequest } from './mock-carrier.js';
export { CarrierCall, postRaw, type CallScript, type CallStep, type LeadRequest, type WebhookSpec } from './carrier-call.js';
export * as carrierScripts from './scripts.js';
export * from './audio-pattern.js';
