import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildResourceAttributes, processInstanceSuffix } from '../../../src/utils/otel-sdk-config.js';
import { forwardLines } from '../../../src/cluster/fork.js';

/*
 * Observability with several processes (docs/scaling.md §7, D7): each process exports
 * under its own `service.instance.id`, forced on when workers are configured and stable
 * across a child's restarts; a one-process server is unchanged. A child's output reaches
 * the container a whole line at a time.
 */
const opts = { version: '1.2.3', hostname: () => 'host-a' };

describe('service.instance.id per process', () => {
  it('one process (no workers): unchanged, off unless enabled', () => {
    expect(processInstanceSuffix({})).toBeNull();
    expect(processInstanceSuffix({ MEDIA_WORKERS: '0', ANALYSIS_WORKERS: '0' })).toBeNull();
    expect(buildResourceAttributes({}, opts)['service.instance.id']).toBeUndefined();
    expect(buildResourceAttributes({ OTEL_SERVICE_INSTANCE_ID_ENABLED: 'true' }, opts)['service.instance.id']).toBe('host-a');
  });

  it('with workers: forced on, the primary suffixed `primary`', () => {
    expect(buildResourceAttributes({ MEDIA_WORKERS: '2' }, opts)['service.instance.id']).toBe('host-a:primary');
    expect(buildResourceAttributes({ MEDIA_WORKERS: '2', OTEL_SERVICE_INSTANCE_ID: 'agency-1' }, opts)['service.instance.id']).toBe('agency-1:primary');
    // Analysis children only count when analysis is on (the block exists only then).
    expect(processInstanceSuffix({ ANALYSIS_WORKERS: '2' })).toBeNull();
    expect(processInstanceSuffix({ ANALYSIS_WORKERS: '2', DIALER_ANALYSIS_ENABLED: 'true' })).toBe('primary');
  });

  it('a child: its role and slot, not its pid', () => {
    expect(buildResourceAttributes({ MA_PROCESS_ROLE: 'media', MA_WORKER_SLOT: '1', MEDIA_WORKERS: '2' }, opts)['service.instance.id']).toBe('host-a:media1');
    expect(buildResourceAttributes({ MA_PROCESS_ROLE: 'analysis', MA_WORKER_SLOT: '0' }, opts)['service.instance.id']).toBe('host-a:analysis0');
  });
});

describe('forwardLines', () => {
  it('writes whole lines only, however the child chunked them', async () => {
    const from = new PassThrough();
    const to = new PassThrough();
    const writes: string[] = [];
    to.on('data', (d: Buffer) => writes.push(d.toString()));
    forwardLines(from, to);
    from.write('{"a":1}\n{"b":');
    from.write('2}\n{"c"');
    from.end(':3}\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
  });
});
