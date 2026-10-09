// VoiceLink is the only carrier here, so the registry read expects one provider
// and the cancel-capable cohort is the empty set. There is no transfer gate (no
// escalation).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canCancelRinging, queuesOutboundDials, type TelephonyProvider } from '../../../src/telephony/types.js';
import { VoicelinkAdapter } from '../../../src/telephony/voicelink/voicelink.adapter.js';

/**
 * `ProviderCapabilities` **substitutes for the compiler**, and that is the whole
 * reason this file exists.
 *
 * `TelephonyProvider.capabilities` is optional — 101 test files reference that
 * interface, mostly through hand-written stubs, so requiring the field would
 * churn every one of them. The cost is that a new adapter which forgets to
 * declare it compiles cleanly, and `canCancelRinging` then reports it as unable
 * to cancel a ringing leg. That direction is the safe one (a spurious warning
 * beats a customer's phone ringing with nobody behind it), but it is still
 * wrong, and nothing else in the tree would say so.
 *
 * So the registry is read from the source of truth rather than re-listed here:
 * the adapter names in `factory.ts`'s `instantiate` switch ARE the registry, and
 * a provider added there but not below fails the first test. The per-adapter
 * verdicts are then pinned individually, because each one is a claim about a
 * carrier's API that someone will eventually be tempted to flip on a hunch —
 * the rationale for each sits at the declaration in that adapter.
 */

/** Minimal, inert configs — every one of these constructors only stores fields. */
const ADAPTERS: ReadonlyArray<{ name: string; provider: TelephonyProvider; cancelRinging: boolean }> = [
  {
    name: 'voicelink',
    // The pilot defect: `endCall` is a documented no-op, VoiceLink's spec exposes
    // no hangup endpoint, so a ringing leg cannot be recalled at all.
    cancelRinging: false,
    provider: new VoicelinkAdapter({
      baseUrl: 'https://voicelink.test', username: 'u', password: 'p',
      webhookBaseUrl: 'https://core.test/api/v1/webhooks/voicelink',
      defaultCallerId: '+919876543210', defaultCountryCode: '91',
    }),
  },
];

/** The registry itself: the provider names `instantiate` can construct. */
function registryProviderNames(): string[] {
  const src = readFileSync(resolve(process.cwd(), 'src/telephony/factory.ts'), 'utf8');
  const body = src.slice(src.indexOf('function instantiate('));
  const switchBody = body.slice(0, body.indexOf('function createProviderInstance'));
  return [...switchBody.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]!);
}

describe('TelephonyProvider capabilities — every adapter in the registry declares them', () => {
  it('covers exactly the providers factory.ts can instantiate', () => {
    const registry = registryProviderNames().sort();
    // Sanity: the extraction found a switch, not an empty string. Without this a
    // renamed function would make the whole assertion vacuously true.
    expect(registry.length).toBe(1);
    expect([...ADAPTERS].map((a) => a.name).sort()).toEqual(registry);
  });

  it.each(ADAPTERS.map((a) => [a.name, a] as const))(
    '%s declares a boolean cancelRinging',
    (_name, entry) => {
      // The assertion the compiler cannot make: the field is present at all.
      expect(entry.provider.capabilities).toBeDefined();
      expect(typeof entry.provider.capabilities?.cancelRinging).toBe('boolean');
    },
  );

  it.each(ADAPTERS.map((a) => [a.name, a] as const))(
    '%s: canCancelRinging agrees with its declaration',
    (_name, entry) => {
      expect(canCancelRinging(entry.provider)).toBe(entry.cancelRinging);
    },
  );

  it('fails closed for a provider that has not answered the question', () => {
    // The state a newly-added adapter is in before someone reads its `endCall`.
    // Unable-to-cancel is the conservative reading: the bridge then warns rather
    // than assuming a leg can be recalled that cannot be.
    expect(canCancelRinging({})).toBe(false);
    expect(canCancelRinging({ capabilities: undefined })).toBe(false);
  });

  it('only voicelink queues outbound dials, and an undeclared adapter reads as dialling at once', () => {
    // A true here moves every dispatch-anchored deadline for the carrier to a
    // pickup window (WS-static and AI calls alike), so a flip is a real change
    // to call lifetimes and lease sizing — stated as a set, like cancelRinging.
    expect(ADAPTERS.filter((a) => queuesOutboundDials(a.provider)).map((a) => a.name)).toEqual(['voicelink']);
    expect(queuesOutboundDials({})).toBe(false);
    expect(queuesOutboundDials({ capabilities: undefined })).toBe(false);
  });

  it('no carried adapter claims it can cancel a ringing leg', () => {
    // Stated as a set as well as per adapter, so a flip is visible as a change
    // to the platform's cancel-capable cohort — which is what the later
    // predictive-pacing work gates on (the capability, never the provider name).
    // VoiceLink cannot cancel a ringing leg, so the cohort is empty.
    expect(ADAPTERS.filter((a) => a.cancelRinging).map((a) => a.name).sort())
      .toEqual([]);
  });
});
