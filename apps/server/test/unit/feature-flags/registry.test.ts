import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  FLAGS,
  defineFlag,
  getFlag,
  allFlags,
  clientExposedFlags,
  resolveEnvDefault,
  type FlagDefinition,
} from '../../../src/feature-flags/registry.js';
import { FIXTURE_FLAGS } from '../../helpers/fixture-flags.js';

/*
 * PORT NOTE (magick-agency): ported from core
 * test/unit/feature-flags/registry.test.ts@4850d1d9. The registry holds only the
 * three agency flags.
 *  - KEPT verbatim: catalog integrity (2), agency_late_binding, "a flag without
 *    envVar resolves to its default".
 *  - MODIFIED: "declares …" now pins exactly the three agency flags; the
 *    whatsapp_personal / whatsapp_personal_groups shape cases pin
 *    agency_dialer_enabled / agency_call_analysis instead; defineFlag and the
 *    boolean resolveEnvDefault cases use agency_dialer_enabled (FF_AGENCY_DIALER);
 *    the number resolveEnvDefault case uses an unregistered copy of core's
 *    prewarm_ring_delay_ms (resolveEnvDefault takes a definition); the
 *    clientExposedFlags case asserts the agency split.
 *  - DELETED: "prewarm flags are NOT client-exposed", the three gold_ii cases and
 *    the prewarm_ring_delay_ms validator case (AI flags, not in this registry).
 */

describe('feature-flag registry', () => {
  describe('FLAGS catalog integrity', () => {
    it('every flag default matches its declared type and passes its validator', () => {
      for (const flag of allFlags()) {
        if (flag.type === 'boolean') expect(typeof flag.default).toBe('boolean');
        if (flag.type === 'number') expect(typeof flag.default).toBe('number');
        if (flag.type === 'string') expect(typeof flag.default).toBe('string');
        if (flag.validate) expect(flag.validate(flag.default)).not.toBe(false);
      }
    });

    it('each flag key equals its map entry key and keys are unique', () => {
      const keys = allFlags().map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const [name, flag] of Object.entries(FLAGS)) {
        expect((flag as FlagDefinition).key).toBe(name);
      }
    });

    it('declares exactly agency_call_analysis, agency_dialer_enabled, agency_late_binding', () => {
      expect(getFlag('agency_call_analysis')).toBeDefined();
      expect(getFlag('agency_dialer_enabled')).toBeDefined();
      expect(getFlag('agency_late_binding')).toBeDefined();
      expect(allFlags().map((f) => f.key)).toEqual(['agency_call_analysis', 'agency_dialer_enabled', 'agency_late_binding']);
    });

    it('agency_dialer_enabled is boolean, default false, tri-scoped, client-exposed', () => {
      const f = getFlag('agency_dialer_enabled')!;
      expect(f.type).toBe('boolean');
      expect(f.default).toBe(false);
      expect(f.scopes).toEqual(expect.arrayContaining(['global', 'tenant', 'account']));
      expect(f.clientExposed).toBe(true);
      expect(f.envVar).toBe('FF_AGENCY_DIALER');
    });

    it('agency_call_analysis is boolean, default off, tri-scoped, client-exposed', () => {
      const f = getFlag('agency_call_analysis')!;
      expect(f.type).toBe('boolean');
      // Off by default: metered and consent-sensitive (see the definition's comment).
      expect(f.default).toBe(false);
      expect(f.scopes).toEqual(expect.arrayContaining(['global', 'tenant', 'account']));
      // The console shows/hides the agency analysis UI on it.
      expect(f.clientExposed).toBe(true);
      expect(f.envVar).toBe('FF_AGENCY_CALL_ANALYSIS');
    });

    it('agency_late_binding is boolean, default OFF, tri-scoped, and NOT client-exposed', () => {
      const f = getFlag('agency_late_binding')!;
      expect(f.type).toBe('boolean');
      // Off by default is the whole safety property: on, a campaign call reaches
      // the agent's console only at the carrier answer, and the bind runs inside
      // the 1s abandonment grace. That is a behaviour change per tenant, not a
      // fleet-wide default.
      expect(f.default).toBe(false);
      expect(f.scopes).toEqual(expect.arrayContaining(['global', 'tenant', 'account']));
      // Deliberately invisible to cusui: the console receives the same frames in
      // the same order, just later, so there is nothing for it to branch on — and
      // a flag the client can read is a flag the client will eventually branch on.
      expect(f.clientExposed).not.toBe(true);
      expect(f.envVar).toBe('FF_AGENCY_LATE_BINDING');
    });
  });

  describe('defineFlag', () => {
    it('freezes the definition', () => {
      const f = getFlag('agency_dialer_enabled')!;
      expect(Object.isFrozen(f)).toBe(true);
    });

    it('throws on a duplicate key registration', () => {
      expect(() =>
        defineFlag({
          key: 'agency_dialer_enabled',
          type: 'boolean',
          default: false,
          description: 'dup',
          owner: 'test',
          scopes: ['tenant'],
        }),
      ).toThrow();
    });
  });

  describe('resolveEnvDefault', () => {
    const ORIG = { ...process.env };
    beforeEach(() => {
      delete process.env['FF_AGENCY_DIALER'];
      delete process.env['AI_PREWARM_ENABLED'];
      delete process.env['AI_PREWARM_RING_DELAY_MS'];
    });
    afterEach(() => {
      process.env = { ...ORIG };
    });

    it('boolean: unset env → registry default (false)', () => {
      expect(resolveEnvDefault(getFlag('agency_dialer_enabled')!)).toBe(false);
    });

    it('boolean: "true" → true, "false"/"0"/"no"/"" → false', () => {
      const f = getFlag('agency_dialer_enabled')!;
      process.env['FF_AGENCY_DIALER'] = 'true';
      expect(resolveEnvDefault(f)).toBe(true);
      for (const falsey of ['false', '0', 'no', '']) {
        process.env['FF_AGENCY_DIALER'] = falsey;
        expect(resolveEnvDefault(f)).toBe(false);
      }
    });

    it('number: parses a valid env, falls back to default on garbage', () => {
      const f = FIXTURE_FLAGS.prewarm_ring_delay_ms;
      process.env['AI_PREWARM_RING_DELAY_MS'] = '5000';
      expect(resolveEnvDefault(f)).toBe(5000);
      process.env['AI_PREWARM_RING_DELAY_MS'] = 'abc';
      expect(resolveEnvDefault(f)).toBe(3000);
      delete process.env['AI_PREWARM_RING_DELAY_MS'];
      expect(resolveEnvDefault(f)).toBe(3000);
    });

    it('a flag without envVar resolves to its default', () => {
      const f = defineFlag({
        key: 'test_no_env',
        type: 'boolean',
        default: true,
        description: 'no env',
        owner: 'test',
        scopes: ['tenant'],
      });
      expect(resolveEnvDefault(f)).toBe(true);
    });
  });

  describe('clientExposedFlags', () => {
    it('returns only clientExposed flags', () => {
      const keys = clientExposedFlags().map((f) => f.key);
      expect(keys).toContain('agency_dialer_enabled');
      expect(keys).toContain('agency_call_analysis');
      expect(keys).not.toContain('agency_late_binding');
    });
  });
});
