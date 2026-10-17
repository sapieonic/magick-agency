/**
 * `bindPoolConnectContext` (`packages/observability/src/trace-context.ts`), against a REAL pg-pool and
 * the real AsyncLocalStorage context manager. A fake pg Client stands in for
 * Postgres. pg-pool hands a released connection to the next waiter from inside
 * the RELEASER's call stack, so this pool shape is what reproduces the defect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { context, trace, type Span } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { bindPoolConnectContext } from '@magick-agency/observability/trace-context';

const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(new tracing.InMemorySpanExporter())],
});
const tracer = trace.getTracer('trace-context-test');

beforeAll(() => provider.register());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

class FakeClient extends EventEmitter {
  connect(cb: (err: Error | null) => void): void { setImmediate(() => cb(null)); }
  query(): Promise<{ rows: [] }> { return Promise.resolve({ rows: [] }); }
  end(cb?: () => void): void { cb?.(); }
}

function makePool(): pg.Pool {
  return new pg.Pool({ Client: FakeClient as unknown as typeof pg.Client, max: 1 });
}

function activeSpanName(): string | undefined {
  return (trace.getActiveSpan() as (Span & { name?: string }) | undefined)?.name;
}

/** B waits for the only connection while A holds it; returns where B's callback ran. */
async function waiterContext(pool: pg.Pool): Promise<string | undefined> {
  const held = await tracer.startActiveSpan('A', async (span) => {
    const client = await pool.connect();
    span.end();
    return client;
  });
  const ranIn = tracer.startActiveSpan('B', (span) => new Promise<string | undefined>((resolve) => {
    pool.connect((err, client, done) => {
      resolve(activeSpanName());
      done?.();
    });
    span.end();
  }));
  // A releases from its own context, which is where pg-pool calls B's callback.
  tracer.startActiveSpan('A-release', (span) => { held.release(); span.end(); });
  const result = await ranIn;
  await pool.end();
  return result;
}

describe('bindPoolConnectContext', () => {
  it('without it, a waiting caller runs in the releaser\'s context (the defect)', async () => {
    expect(await waiterContext(makePool())).toBe('A-release');
  });

  it('with it, a waiting caller runs in its own context', async () => {
    expect(await waiterContext(bindPoolConnectContext(makePool()))).toBe('B');
  });

  it('leaves the promise form working', async () => {
    const pool = bindPoolConnectContext(makePool());
    const client = await pool.connect();
    client.release();
    await pool.end();
  });
});

describe('wiring (source audit)', () => {
  it('the app pool binds connect callbacks', () => {
    const src = readFileSync(resolve(process.cwd(), '../../packages/db/src/connection.ts'), 'utf8');
    expect(src).toMatch(/bindPoolConnectContext\(pool\);/);
  });
});
