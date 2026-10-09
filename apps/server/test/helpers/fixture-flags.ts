import type { FlagDefinition } from '../../src/feature-flags/registry.js';

/**
 * PORT NOTE (magick-agency): UNREGISTERED copies of core flag definitions
 * (`magic-voice-core/src/feature-flags/registry.ts@4850d1d9`, verbatim fields)
 * that the ported service/snapshot suites use as test subjects.
 *
 * Agency's registry holds only the three agency flags, all boolean and all
 * scoped global+tenant+account. Core's suites exercise the RESOLVER's mechanics
 * through flags of other shapes — a number flag, a flag with no account scope, a
 * flag whose registry default is `true` — and those mechanics are the service's,
 * not the flags'. `getValue`, `isEnabled` and `snapshot()` resolve from the
 * definition they are handed and never consult the registry, so a plain
 * (unregistered) definition is a faithful subject for them. These objects are
 * never passed to `defineFlag`, so `allFlags()` / `resolveAll()` — which are
 * asserted against the real agency registry — cannot see them.
 */
const isSipConnectionCap = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;

const isRingDelay = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 30000;

export const FIXTURE_FLAGS = {
  whatsapp_personal: Object.freeze({
    key: 'whatsapp_personal',
    type: 'boolean',
    default: false,
    envVar: 'FF_WHATSAPP_PERSONAL',
    scopes: ['global', 'tenant'],
    clientExposed: true,
    owner: 'messaging',
    description: 'WhatsApp personal (per-tenant BYO number) connections',
  }) as FlagDefinition<boolean>,
  custom_sip: Object.freeze({
    key: 'custom_sip',
    type: 'boolean',
    default: false,
    envVar: 'FF_CUSTOM_SIP',
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true,
    owner: 'voice',
    description: 'Customer bring-your-own SIP trunk connections for outbound calls',
  }) as FlagDefinition<boolean>,
  max_sip_connections: Object.freeze({
    key: 'max_sip_connections',
    type: 'number',
    default: 10,
    envVar: 'FF_MAX_SIP_CONNECTIONS',
    scopes: ['global', 'tenant'],
    clientExposed: false,
    owner: 'voice',
    description: 'Max active customer SIP connections a tenant may create (0..1000, per-tenant)',
    validate: isSipConnectionCap,
  }) as FlagDefinition<number>,
  knowledge_bases_enabled: Object.freeze({
    key: 'knowledge_bases_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_KNOWLEDGE_BASES',
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true,
    owner: 'voice',
    description: 'Native catalog grounding: upload a CSV catalog the agent can search mid-call',
  }) as FlagDefinition<boolean>,
  webrtc_calls_enabled: Object.freeze({
    key: 'webrtc_calls_enabled',
    type: 'boolean',
    default: false,
    envVar: 'FF_WEBRTC_CALLS_ENABLED',
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true,
    owner: 'voice',
    description: 'WebRTC browser→PSTN human calling (softphone)',
  }) as FlagDefinition<boolean>,
  gold_ii: Object.freeze({
    key: 'gold_ii',
    type: 'boolean',
    default: false,
    envVar: 'FF_GOLD_II',
    scopes: ['global', 'tenant', 'account'],
    clientExposed: true,
    owner: 'voice',
    description: 'Gold-II AI pipeline tier (xAI Grok voice) — gated',
  }) as FlagDefinition<boolean>,
  prewarm_enabled: Object.freeze({
    key: 'prewarm_enabled',
    type: 'boolean',
    default: true,
    envVar: 'AI_PREWARM_ENABLED',
    scopes: ['tenant'],
    clientExposed: false,
    owner: 'voice',
    description: 'Pre-warm the AI pipeline during ringing (per-tenant override)',
  }) as FlagDefinition<boolean>,
  prewarm_ring_delay_ms: Object.freeze({
    key: 'prewarm_ring_delay_ms',
    type: 'number',
    default: 3000,
    envVar: 'AI_PREWARM_RING_DELAY_MS',
    scopes: ['tenant'],
    clientExposed: false,
    owner: 'voice',
    description: 'Deferred pre-warm ring delay in ms (0..30000, per-tenant override)',
    validate: isRingDelay,
  }) as FlagDefinition<number>,
} as const;
