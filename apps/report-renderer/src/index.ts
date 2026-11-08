/**
 * `@magick-agency/report-renderer` (RP15): renders a report dataset to PDF and Excel.
 *
 * The server's inline adapter calls {@link renderRun} with an IO over its own S3 module; the
 * Lambda (`src/lambda.ts`, a separate entry, not exported here) calls it with an IO over
 * `@aws-sdk/client-s3`. Nothing exported here imports Lambda-only code.
 */
export { renderRun, parseDataset, type RenderRunOptions, type RenderLogEvent } from './render-run';
export { detailReaderFromIO, ndjsonGzRows, type RendererIO, type DetailReader } from './io';
export { RenderFailure } from './errors';
export { renderPdf, renderReportHtml, reportTitle, type PdfOptions, type HtmlOptions } from './pdf/render-pdf';
export { findChrome, launchBrowser, CHROME_ARGS, type ChromeOptions } from './pdf/chrome';
export { loadFonts, type FontSet } from './pdf/fonts';
export { writeWorkbook, truncationNote } from './xlsx/workbook';
export { signCallback } from './signature';
export { RENDERER_VERSION } from './version';
