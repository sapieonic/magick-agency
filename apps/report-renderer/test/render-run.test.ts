/**
 * renderRun with an in-memory bucket: success (both files, the callback body), an unsupported
 * dataset version, an unreadable dataset or detail file, a failing write, a malformed message.
 */
import { describe, expect, it } from 'vitest';
import { REPORT_FORMAT_CONTENT_TYPES, type ReportRenderMessage } from '@magick-agency/contracts/reports';
import { findChrome } from '../src/pdf/chrome';
import { renderRun } from '../src/render-run';
import { RENDERER_VERSION } from '../src/version';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';
import { DATASET_KEY, MemoryIO } from './helpers/memory-io';
import { readWorkbook } from './helpers/xlsx';

const chrome = findChrome();

function message(runId: string, formats: ReportRenderMessage['formats'] = ['pdf', 'xlsx']): ReportRenderMessage {
  return {
    run_id: runId,
    attempt: 2,
    dataset_version: 1,
    bucket: 'magick-agency-test',
    dataset_key: DATASET_KEY,
    output_prefix: `reports/t/a/${runId}/`,
    formats,
    callback_url: 'https://agency.example.test/webhooks/reports/rendered',
  };
}

describe('renderRun', () => {
  it.runIf(chrome)('renders both formats to their keys and describes them in the callback', async () => {
    const { dataset, details } = agentFixture();
    const io = new MemoryIO(dataset, DATASET_KEY, details);
    const events: string[] = [];
    const cb = await renderRun(message(dataset.run_id), io, { log: (e) => events.push(e.event) });
    expect(cb).toMatchObject({ run_id: dataset.run_id, attempt: 2, status: 'rendered', error: null, renderer_version: RENDERER_VERSION });
    expect(cb.files.map((f) => f.key)).toEqual([`reports/t/a/${dataset.run_id}/report.pdf`, `reports/t/a/${dataset.run_id}/report.xlsx`]);
    for (const f of cb.files) expect(f.bytes).toBe(io.objects.get(f.key)!.length);
    expect(io.writes.map((w) => w.contentType)).toEqual([REPORT_FORMAT_CONTENT_TYPES.pdf, REPORT_FORMAT_CONTENT_TYPES.xlsx]);
    expect(io.objects.get(cb.files[0]!.key)!.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await readWorkbook(io.objects.get(cb.files[1]!.key)!)).worksheets.length).toBeGreaterThan(5);
    expect(events).toEqual(['render.start', 'render.dataset_read', 'render.format_done', 'render.format_done', 'render.done']);
  });

  it('renders the workbook alone when only xlsx is asked for', async () => {
    const { dataset, details } = campaignFixture();
    const io = new MemoryIO(dataset, DATASET_KEY, details);
    const cb = await renderRun(message(dataset.run_id, ['xlsx']), io);
    expect(cb.status).toBe('rendered');
    expect(cb.files).toEqual([{ format: 'xlsx', key: `reports/t/a/${dataset.run_id}/report.xlsx`, bytes: io.writes[0]!.bytes }]);
  });

  it('refuses a dataset version it does not draw, in the dataset or the message', async () => {
    const { dataset, details } = agentFixture();
    const io = new MemoryIO({ ...dataset, dataset_version: 2 } as unknown as typeof dataset, DATASET_KEY, details);
    const cb = await renderRun(message(dataset.run_id), io);
    expect(cb).toMatchObject({ status: 'failed', files: [], error: { code: 'dataset_version_unsupported' } });
    expect(io.writes).toHaveLength(0);

    const msg = { ...message(dataset.run_id), dataset_version: 3 } as unknown as ReportRenderMessage;
    expect((await renderRun(msg, new MemoryIO(dataset, DATASET_KEY, details))).error?.code).toBe('dataset_version_unsupported');
  });

  it('reports a missing or broken dataset as dataset_unreadable', async () => {
    const { dataset } = agentFixture();
    expect((await renderRun(message(dataset.run_id), new MemoryIO())).error?.code).toBe('dataset_unreadable');
    const io = new MemoryIO();
    io.objects.set(DATASET_KEY, Buffer.from('{not json'));
    expect((await renderRun(message(dataset.run_id), io)).error?.code).toBe('dataset_unreadable');
    // A dataset for another run is not drawn under this run's keys.
    expect((await renderRun(message('another-run'), new MemoryIO(dataset))).error?.code).toBe('dataset_unreadable');
  });

  it('reports a detail file that will not read as dataset_unreadable', async () => {
    const { dataset, details } = agentFixture();
    const io = new MemoryIO(dataset, DATASET_KEY, details);
    io.objects.set(dataset.detail_files[1]!.key, Buffer.from('not gzip at all'));
    const cb = await renderRun(message(dataset.run_id, ['xlsx']), io);
    expect(cb).toMatchObject({ status: 'failed', error: { code: 'dataset_unreadable' } });
  });

  it('maps a failing write to upload_failed', async () => {
    const { dataset, details } = campaignFixture();
    const io = new MemoryIO(dataset, DATASET_KEY, details);
    io.failWrites = true;
    const cb = await renderRun(message(dataset.run_id, ['xlsx']), io);
    expect(cb).toMatchObject({ status: 'failed', files: [], error: { code: 'upload_failed' } });
    expect(cb.error!.message).toContain('AccessDenied');
  });

  it('maps a PDF that cannot be drawn to render_failed, keeping the files already written', async () => {
    const { dataset, details } = campaignFixture();
    const io = new MemoryIO(dataset, DATASET_KEY, details);
    const cb = await renderRun(message(dataset.run_id, ['xlsx', 'pdf']), io, { chromePath: '/nonexistent/chrome' });
    expect(cb.status).toBe('failed');
    expect(cb.error!.code).toBe('render_failed');
    expect(cb.files.map((f) => f.format)).toEqual(['xlsx']);
  });

  it('throws for a malformed message (a caller bug, not a render failure)', async () => {
    const bad = { ...message('r'), formats: [] } as ReportRenderMessage;
    await expect(renderRun(bad, new MemoryIO())).rejects.toThrow(TypeError);
    await expect(renderRun({ ...message('r'), output_prefix: 'no-slash' }, new MemoryIO())).rejects.toThrow(/output_prefix/);
  });
});
