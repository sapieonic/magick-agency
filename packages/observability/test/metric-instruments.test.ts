import { describe, expect, it } from 'vitest';
import type { Meter } from '@opentelemetry/api';
import { gauge } from '../src/metric-instruments.js';

/**
 * The settable gauge's collection: what each callback run observes. `retire` reports a label set
 * once more and then never again, so a series whose subject is gone (an inbound route nobody waits
 * on) ends on its last value instead of being exported for the rest of the process's life.
 */

type Observation = { value: number; attributes?: Record<string, unknown> };

function fakeMeter() {
  let callback: ((result: { observe: (value: number, attributes?: Record<string, unknown>) => void }) => void) | null = null;
  const meter = {
    createObservableGauge: () => ({ addCallback: (cb: typeof callback) => { callback = cb; } }),
  } as unknown as Meter;
  const collect = (): Observation[] => {
    const seen: Observation[] = [];
    callback!({ observe: (value, attributes) => { seen.push(attributes ? { value, attributes } : { value }); } });
    return seen;
  };
  return { meter, collect };
}

describe('gauge', () => {
  it('observes every label set it was given, at every collection', () => {
    const { meter, collect } = fakeMeter();
    const g = gauge<'route_id'>(meter, 'g', { description: 'd' });
    g.set({ route_id: 'r1' }, 2);
    g.set({ route_id: 'r2' }, 1);
    expect(collect()).toEqual([{ value: 2, attributes: { route_id: 'r1' } }, { value: 1, attributes: { route_id: 'r2' } }]);
    expect(collect()).toHaveLength(2);
  });

  it('retire: the value is observed at the next collection only, then the label set is gone; a later set brings it back', () => {
    const { meter, collect } = fakeMeter();
    const g = gauge<'route_id'>(meter, 'g', { description: 'd' });
    g.set({ route_id: 'r1' }, 3);
    g.set({ route_id: 'r2' }, 1);
    g.retire({ route_id: 'r1' }, 0);
    expect(collect()).toEqual([{ value: 0, attributes: { route_id: 'r1' } }, { value: 1, attributes: { route_id: 'r2' } }]);
    expect(collect()).toEqual([{ value: 1, attributes: { route_id: 'r2' } }]);
    g.set({ route_id: 'r1' }, 4);
    expect(collect()).toEqual([{ value: 1, attributes: { route_id: 'r2' } }, { value: 4, attributes: { route_id: 'r1' } }]);
    expect(collect()).toHaveLength(2);
  });

  it('a set after a retire, before any collection, keeps the label set', () => {
    const { meter, collect } = fakeMeter();
    const g = gauge<'route_id'>(meter, 'g', { description: 'd' });
    g.retire({ route_id: 'r1' }, 0);
    g.set({ route_id: 'r1' }, 2);
    expect(collect()).toEqual([{ value: 2, attributes: { route_id: 'r1' } }]);
    expect(collect()).toEqual([{ value: 2, attributes: { route_id: 'r1' } }]);
  });
});
