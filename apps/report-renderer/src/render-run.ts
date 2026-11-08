/**
 * One render: read the dataset, draw each requested format, store it, describe the result as the
 * callback body. Shared by the Lambda (`src/lambda.ts`, which signs and POSTs the result) and the
 * server's inline adapter (which applies it directly).
 *
 * Failures are RESULTS, not exceptions: a dataset that cannot be read, a version this renderer
 * does not draw, a template or workbook that throws, a write that fails — each becomes
 * `status: 'failed'` with its `ReportRendererFailureCode`. Only a malformed message (a caller
 * bug) throws.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  REPORT_DATASET_VERSION,
  REPORT_FORMAT_CONTENT_TYPES,
  REPORT_FORMATS,
  REPORT_KINDS,
  REPORT_OUTPUT_FILE_NAMES,
  type ReportDataset,
  type ReportFormat,
  type ReportRenderCallback,
  type ReportRenderMessage,
  type ReportRendererFailureCode,
} from '@magick-agency/contracts/reports';
import { RenderFailure, errorMessage } from './errors';
import { detailReaderFromIO, type RendererIO } from './io';
import { renderPdf, type PdfOptions } from './pdf/render-pdf';
import { RENDERER_VERSION } from './version';
import { writeWorkbook } from './xlsx/workbook';

/** A structured log line; never carries dataset contents (they hold personal data). */
export interface RenderLogEvent {
  event: 'render.start' | 'render.dataset_read' | 'render.format_done' | 'render.failed' | 'render.done';
  run_id: string;
  attempt: number;
  format?: ReportFormat;
  bytes?: number;
  ms?: number;
  code?: ReportRendererFailureCode;
  error?: string;
}

export interface RenderRunOptions extends Omit<PdfOptions, 'fonts'> {
  /** Where the workbook is written before upload (default: the OS temp dir; `/tmp` on Lambda). */
  tmpDir?: string;
  log?: (event: RenderLogEvent) => void;
}

function assertMessage(message: ReportRenderMessage): void {
  const bad = (why: string) => {
    throw new TypeError(`renderRun: invalid render message (${why})`);
  };
  if (!message || typeof message !== 'object') bad('not an object');
  if (typeof message.run_id !== 'string' || message.run_id === '') bad('run_id');
  if (!Number.isInteger(message.attempt) || message.attempt < 1) bad('attempt');
  if (typeof message.dataset_key !== 'string' || message.dataset_key === '') bad('dataset_key');
  if (typeof message.output_prefix !== 'string' || !message.output_prefix.endsWith('/')) bad('output_prefix must end in /');
  if (!Array.isArray(message.formats) || message.formats.length === 0) bad('formats');
  for (const f of message.formats) if (!(REPORT_FORMATS as readonly string[]).includes(f)) bad(`format ${String(f)}`);
}

/** Parse and check `dataset.json` far enough to draw it. */
export function parseDataset(body: Buffer, message: Pick<ReportRenderMessage, 'run_id'>): ReportDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new RenderFailure('dataset_unreadable', `dataset.json is not JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') throw new RenderFailure('dataset_unreadable', 'dataset.json is not an object');
  const d = parsed as Partial<ReportDataset>;
  if (d.dataset_version !== REPORT_DATASET_VERSION) {
    throw new RenderFailure('dataset_version_unsupported', `dataset_version ${String(d.dataset_version)} is not ${REPORT_DATASET_VERSION}`);
  }
  if (!(REPORT_KINDS as readonly string[]).includes(String(d.kind))) throw new RenderFailure('dataset_unreadable', `unknown kind ${String(d.kind)}`);
  if (d.run_id !== message.run_id) throw new RenderFailure('dataset_unreadable', 'dataset run_id does not match the message');
  if (!d.range || typeof d.range.timezone !== 'string' || !Array.isArray(d.detail_files)) throw new RenderFailure('dataset_unreadable', 'dataset is missing range or detail_files');
  return d as ReportDataset;
}

/**
 * Render a run's files and return the callback body. Never throws for a render failure; throws a
 * `TypeError` for a malformed message.
 */
export async function renderRun(message: ReportRenderMessage, io: RendererIO, options: RenderRunOptions = {}): Promise<ReportRenderCallback> {
  assertMessage(message);
  const log = options.log ?? (() => undefined);
  const base = { run_id: message.run_id, attempt: message.attempt };
  const files: ReportRenderCallback['files'] = [];
  const started = Date.now();
  log({ event: 'render.start', ...base });

  const fail = (code: ReportRendererFailureCode, error: unknown): ReportRenderCallback => {
    const msg = errorMessage(error);
    log({ event: 'render.failed', ...base, code, error: msg, ms: Date.now() - started });
    return { ...base, status: 'failed', files, error: { code, message: msg }, renderer_version: RENDERER_VERSION };
  };

  if (message.dataset_version !== REPORT_DATASET_VERSION) {
    return fail('dataset_version_unsupported', new Error(`message dataset_version ${String(message.dataset_version)} is not ${REPORT_DATASET_VERSION}`));
  }

  let dataset: ReportDataset;
  try {
    let body: Buffer;
    try {
      body = await io.readObject(message.dataset_key);
    } catch (error) {
      throw new RenderFailure('dataset_unreadable', `dataset.json could not be read: ${errorMessage(error)}`, { cause: error });
    }
    dataset = parseDataset(body, message);
  } catch (error) {
    return error instanceof RenderFailure ? fail(error.code, error) : fail('dataset_unreadable', error);
  }
  log({ event: 'render.dataset_read', ...base, ms: Date.now() - started });

  const formats = [...new Set(message.formats)];
  for (const format of formats) {
    const t0 = Date.now();
    const key = `${message.output_prefix}${REPORT_OUTPUT_FILE_NAMES[format]}`;
    try {
      const bytes = format === 'pdf' ? await pdfFile(dataset, key, io, options) : await xlsxFile(dataset, key, io, options);
      files.push({ format, key, bytes });
      log({ event: 'render.format_done', ...base, format, bytes, ms: Date.now() - t0 });
    } catch (error) {
      return error instanceof RenderFailure ? fail(error.code, error) : fail('render_failed', error);
    }
  }
  log({ event: 'render.done', ...base, ms: Date.now() - started });
  return { ...base, status: 'rendered', files, error: null, renderer_version: RENDERER_VERSION };
}

async function upload(io: RendererIO, key: string, body: Buffer | ReturnType<typeof createReadStream>, format: ReportFormat, size: number): Promise<number> {
  try {
    const { bytes } = await io.writeObject(key, body, REPORT_FORMAT_CONTENT_TYPES[format], size);
    return bytes;
  } catch (error) {
    throw new RenderFailure('upload_failed', `writing ${REPORT_OUTPUT_FILE_NAMES[format]} failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function pdfFile(dataset: ReportDataset, key: string, io: RendererIO, options: RenderRunOptions): Promise<number> {
  let pdf: Buffer;
  try {
    pdf = await renderPdf(dataset, options);
  } catch (error) {
    if (error instanceof RenderFailure) throw error;
    throw new RenderFailure('render_failed', `PDF: ${errorMessage(error)}`, { cause: error });
  }
  return upload(io, key, pdf, 'pdf', pdf.length);
}

async function xlsxFile(dataset: ReportDataset, key: string, io: RendererIO, options: RenderRunOptions): Promise<number> {
  const dir = await mkdtemp(join(options.tmpDir ?? tmpdir(), 'report-'));
  const path = join(dir, 'report.xlsx');
  try {
    try {
      const out = createWriteStream(path);
      const done = finished(out);
      try {
        await writeWorkbook(dataset, detailReaderFromIO(io), out);
      } catch (error) {
        out.destroy();
        await done.catch(() => undefined);
        throw error;
      }
      await done;
    } catch (error) {
      if (error instanceof RenderFailure) throw error;
      throw new RenderFailure('render_failed', `workbook: ${errorMessage(error)}`, { cause: error });
    }
    const { size } = await stat(path);
    return await upload(io, key, createReadStream(path), 'xlsx', size);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
