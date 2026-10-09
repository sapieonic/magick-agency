import { describe, expect, it } from 'vitest';
import { Traced, withSpan } from '../src/tracing.js';

// Core has no tracing tests (magic-voice-core/test/unit/utils has none); these
// pin that the decorator and helper are inert without an SDK and keep results.
class Probe {
  @Traced('probe.run')
  async run(x: number): Promise<number> {
    return x * 2;
  }
}

describe('tracing (no SDK registered)', () => {
  it('withSpan returns the wrapped result', async () => {
    await expect(withSpan('t', {}, async () => 42)).resolves.toBe(42);
  });

  it('@Traced preserves the method result', async () => {
    await expect(new Probe().run(21)).resolves.toBe(42);
  });
});
