// The render dispatchers: the SQS body is exactly the render message (keys derived from the run,
// the callback URL the configured base plus the webhook path); the inline dispatcher calls the
// renderer it loads one run at a time, applies the callback it returns, and turns a renderer that
// cannot load or throws into a failed `render_failed` callback through the same apply path.
import { describe, expect, it, vi } from 'vitest';
import type { ReportRenderCallback, ReportRenderMessage } from '@magick-agency/contracts/reports';
import {
  REPORT_CALLBACK_PATH,
  buildRenderMessage,
  createInlineDispatcher,
  createSqsDispatcher,
  rendererLogLine,
  type ReportRendererIO,
  type ReportRendererModule,
} from '../../../../src/agency/reports/dispatch.js';
import { createReportDispatcher } from '../../../../src/agency/reports/pipeline.js';
import { agencyConfigSchema } from '../../../../src/config/blocks/agency.js';
import { reportOutputPrefix } from '../../../../src/agency/reports/report-keys.js';
import { ACCOUNT, RUN, TENANT, runRecord } from './run-fixture.js';

const DATASET_KEY = `report-datasets/${TENANT}/${ACCOUNT}/${RUN}/dataset.json`;
const run = runRecord({ dataset_key: DATASET_KEY, formats: ['pdf'] });
const io: ReportRendererIO = {
  readObject: vi.fn(), readStream: vi.fn(), writeObject: vi.fn(),
};

describe('buildRenderMessage', () => {
  it('derives every key from the run, never from anything else', () => {
    expect(buildRenderMessage(run, 2, { bucket: 'b', callbackUrl: 'https://x/webhooks/reports/rendered' })).toEqual({
      run_id: RUN,
      attempt: 2,
      dataset_version: 1,
      bucket: 'b',
      dataset_key: DATASET_KEY,
      output_prefix: reportOutputPrefix({ tenantId: TENANT, accountId: ACCOUNT, runId: RUN }),
      formats: ['pdf'],
      callback_url: 'https://x/webhooks/reports/rendered',
    });
  });

  it('refuses a run with no recorded dataset', () => {
    expect(() => buildRenderMessage(runRecord({ dataset_key: null }), 1, { bucket: 'b', callbackUrl: 'u' })).toThrow();
  });
});

describe('the SQS dispatcher', () => {
  it('sends the render message as the body, to the queue, with the callback URL', async () => {
    const send = vi.fn(async () => {});
    const dispatcher = createSqsDispatcher({
      queueUrl: 'https://sqs.eu-west-2.amazonaws.com/1/report-jobs',
      bucket: 'bucket',
      callbackBaseUrl: 'https://api.example.com/',
      sender: { send },
    });
    await dispatcher.dispatch(run, 3);
    expect(send).toHaveBeenCalledTimes(1);
    const [queue, body] = send.mock.calls[0]! as unknown as [string, string];
    expect(queue).toBe('https://sqs.eu-west-2.amazonaws.com/1/report-jobs');
    const message = JSON.parse(body) as ReportRenderMessage;
    expect(message).toMatchObject({ run_id: RUN, attempt: 3, bucket: 'bucket', dataset_key: DATASET_KEY });
    expect(message.callback_url).toBe(`https://api.example.com${REPORT_CALLBACK_PATH}`);
    expect(REPORT_CALLBACK_PATH).toBe('/webhooks/reports/rendered');
  });

  it('propagates a send failure (the run stays rendering; the tick re-sends)', async () => {
    const dispatcher = createSqsDispatcher({
      queueUrl: 'q', bucket: 'b', callbackBaseUrl: 'https://a', sender: { send: async () => { throw new Error('throttled'); } },
    });
    await expect(dispatcher.dispatch(run, 1)).rejects.toThrow('throttled');
  });
});

describe('the inline dispatcher', () => {
  function renderer(impl?: (m: ReportRenderMessage) => Promise<ReportRenderCallback>) {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const mod: ReportRendererModule = {
      renderRun: vi.fn(async (message: ReportRenderMessage) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(message.run_id);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return impl ? impl(message) : {
          run_id: message.run_id, attempt: message.attempt, status: 'rendered' as const,
          files: [], error: null, renderer_version: 'fake',
        };
      }),
    };
    return { mod, calls, maxActive: () => maxActive };
  }

  it('renders through the loaded renderer and applies the callback it returns', async () => {
    const r = renderer();
    const apply = vi.fn(async () => ({}));
    const dispatcher = createInlineDispatcher({ bucket: 'b', chromePath: '/usr/bin/chromium', apply, io, loader: async () => r.mod });
    await dispatcher.dispatch(run, 1);
    await dispatcher.idle();
    expect(r.mod.renderRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: RUN, attempt: 1, bucket: 'b' }), io, { chromePath: '/usr/bin/chromium', log: expect.any(Function) });
    expect(apply).toHaveBeenCalledWith(RUN, 1, expect.objectContaining({ status: 'rendered', renderer_version: 'fake' }));
  });

  it('omits chromePath when none is configured (the renderer discovers Chromium)', async () => {
    const r = renderer();
    const dispatcher = createInlineDispatcher({ bucket: 'b', apply: async () => ({}), io, loader: async () => r.mod });
    await dispatcher.dispatch(run, 1);
    await dispatcher.idle();
    expect(r.mod.renderRun).toHaveBeenCalledWith(expect.anything(), io, { log: expect.any(Function) });
  });

  it('passes the renderer a log callback: each event becomes a structured line (run id, attempt, stage, bytes, ms)', async () => {
    const events: unknown[] = [];
    const mod: ReportRendererModule = {
      renderRun: vi.fn(async (message: ReportRenderMessage, _io, options) => {
        options?.log?.({ event: 'render.format_done', run_id: message.run_id, attempt: message.attempt, format: 'pdf', bytes: 1234, ms: 56 });
        options?.log?.({ event: 'render.done', run_id: message.run_id, attempt: message.attempt, ms: 99, dataset: 'never logged' });
        return { run_id: message.run_id, attempt: message.attempt, status: 'rendered' as const, files: [], error: null, renderer_version: 'fake' };
      }),
    };
    const dispatcher = createInlineDispatcher({
      bucket: 'b', apply: async () => ({}), io, loader: async () => mod, logEvent: (e) => events.push(rendererLogLine(e)),
    });
    await dispatcher.dispatch(run, 2);
    await dispatcher.idle();
    expect(events).toEqual([
      { runId: RUN, attempt: 2, stage: 'render.format_done', format: 'pdf', bytes: 1234, ms: 56 },
      { runId: RUN, attempt: 2, stage: 'render.done', ms: 99 },
    ]);
  });

  it('a log sink that throws never fails the render', async () => {
    const apply = vi.fn(async () => ({}));
    const mod: ReportRendererModule = {
      renderRun: async (message, _io, options) => {
        options?.log?.({ event: 'render.start', run_id: message.run_id, attempt: message.attempt });
        return { run_id: message.run_id, attempt: message.attempt, status: 'rendered', files: [], error: null, renderer_version: 'fake' };
      },
    };
    const dispatcher = createInlineDispatcher({ bucket: 'b', apply, io, loader: async () => mod, logEvent: () => { throw new Error('sink down'); } });
    await dispatcher.dispatch(run, 1);
    await dispatcher.idle();
    expect(apply).toHaveBeenCalledWith(RUN, 1, expect.objectContaining({ status: 'rendered' }));
  });

  it('renders one run at a time, in the order sent', async () => {
    const r = renderer();
    const dispatcher = createInlineDispatcher({ bucket: 'b', apply: async () => ({}), io, loader: async () => r.mod });
    const ids = ['99999999-9999-4999-8999-999999999991', '99999999-9999-4999-8999-999999999992', '99999999-9999-4999-8999-999999999993'];
    for (const id of ids) await dispatcher.dispatch({ ...run, id }, 1);
    await dispatcher.idle();
    expect(r.calls).toEqual(ids);
    expect(r.maxActive()).toBe(1);
  });

  it('a renderer that cannot load fails the run render_failed through apply, and the queue goes on', async () => {
    const apply = vi.fn(async () => ({}));
    let attempt = 0;
    const r = renderer();
    const dispatcher = createInlineDispatcher({
      bucket: 'b', apply, io,
      loader: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Cannot find package '@magick-agency/report-renderer'");
        return r.mod;
      },
    });
    await dispatcher.dispatch(run, 1);
    await dispatcher.dispatch(run, 2);
    await dispatcher.idle();
    expect(apply).toHaveBeenNthCalledWith(1, RUN, 1, expect.objectContaining({
      status: 'failed', files: [], error: expect.objectContaining({ code: 'render_failed' }),
    }));
    expect(apply).toHaveBeenNthCalledWith(2, RUN, 2, expect.objectContaining({ status: 'rendered' }));
  });

  it('a renderer that throws (a malformed message) is a failed callback too', async () => {
    const apply = vi.fn(async () => ({}));
    const r = renderer(async () => { throw new TypeError('bad message'); });
    const dispatcher = createInlineDispatcher({ bucket: 'b', apply, io, loader: async () => r.mod });
    await dispatcher.dispatch(run, 1);
    await dispatcher.idle();
    expect(apply).toHaveBeenCalledWith(RUN, 1, expect.objectContaining({ status: 'failed' }));
  });
});

describe('createReportDispatcher', () => {
  it('builds the inline dispatcher by default and the SQS one under `sqs`', async () => {
    const reports = agencyConfigSchema.parse({}).agency.reports;
    const inline = createReportDispatcher({ s3: undefined, agency: { reports } }, {
      loader: async () => ({ renderRun: async (m) => ({ run_id: m.run_id, attempt: m.attempt, status: 'failed', files: [], error: null, renderer_version: 'x' }) }),
    });
    expect(inline).toBeDefined();
    const sqs = createReportDispatcher({
      s3: { audioBucket: 'b', region: 'eu-west-2', accessKeyId: 'k', secretAccessKey: 's' },
      agency: { reports: { ...reports, renderer: 'sqs', sqsQueueUrl: 'https://q', callbackBaseUrl: 'https://a', callbackSecret: 'x'.repeat(32) } },
    });
    expect(sqs).toBeDefined();
  });
});
