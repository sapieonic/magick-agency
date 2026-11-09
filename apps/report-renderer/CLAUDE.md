# apps/report-renderer

Renders a report dataset (`@magick-agency/contracts/reports`) to `report.pdf` and `report.xlsx`
(RP15, `docs/reports.md`). Depends only on the contracts plus rendering libraries; never on the
database, the server or the clock (it prints `generated_at`).

- **Public entry `src/index.ts`**: `renderRun(message, io, options)` (the server's inline adapter
  and the Lambda both call it), `renderPdf`, `renderReportHtml`, `writeWorkbook`, `findChrome`,
  `signCallback`. Keep it free of Lambda-only imports: `src/lambda.ts` and `src/lambda/` are the
  Lambda's own entry and are not exported.
- **Failures are results**: `renderRun` returns `status: 'failed'` with a
  `ReportRendererFailureCode` (`dataset_unreadable`, `dataset_version_unsupported`,
  `render_failed`, `upload_failed`); it throws only for a malformed message.
- **PDF**: TSX templates in `src/pdf/templates/` → `renderToStaticMarkup` → headless Chromium
  through `puppeteer-core` (A4, header and "Page X of Y" footer). Charts are static SVG
  (`src/pdf/charts.tsx`) at the 688 px content width. IBM Plex is embedded from `@fontsource`
  woff2 files (`src/pdf/fonts.ts`; `REPORT_RENDERER_FONTS_DIR` overrides where they are read
  from); use only glyphs Plex has (no ▲ ✓: use ↑ ↓), or the Lambda,
  which has almost no system fonts, prints boxes. Numbers in `en-IN` (the console's
  `DISPLAY_LOCALE`), dates British style, everything in the dataset's zone.
- **Rates**: a rate below its floor or with no denominator is words (`src/format`), never 0. The
  `self` audience's dataset has `benchmark` and `quality` null: those sections are not drawn.
- **Excel**: exceljs' streaming `WorkbookWriter`; detail sheets stream from gzipped NDJSON
  (`src/io.ts`), so a 100,000-row sheet keeps the heap flat (`test/workbook-memory.test.ts`).
- **Lambda** (`src/lambda.ts`, handler `index.handler`): SQS batch size 1, S3 via the default
  credential chain, one `PutObject` per file (no multipart: the role has only `s3:PutObject` on
  `reports/*`), callback signed per contracts, each try bounded by 15 s, retried three times; an
  undeliverable callback is a `batchItemFailures` entry, but a final 4xx (anything but 408 and
  429: a bad signature, a rejected body, no route) is logged and not redelivered, since a
  re-render would be refused again (the server's tick finds the files in S3 by itself). A record
  received after its `superseded_after` (the server's deadline for that attempt) is dropped
  without rendering and without a batch failure: its callback could only be `stale`. `pnpm build:lambda` writes `dist/report-renderer-lambda.zip`
  (`index.mjs` and `fonts/` at the zip root).
- **Chromium versions go together.** The Lambda layer is `@sparticuz/chromium` **153.0.0**
  (Chromium 153), mounted at `/opt/nodejs/node_modules` and resolved there by
  `src/lambda/chromium.ts` (ES modules ignore NODE_PATH); it is not bundled. `puppeteer-core` is
  pinned to **25.11.0**, the release built for Chrome 153. Bump both together.
- **Chrome for local runs and tests**: `findChrome()` tries `AGENCY_REPORTS_CHROME_PATH`,
  `CHROME_PATH`, Playwright's `/opt/pw-browsers/chromium-*/chrome-linux*/chrome`, then
  `/usr/bin/google-chrome` (GitHub's Ubuntu runners), `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`,
  `/usr/bin/chromium-browser`. The PDF tests fail in CI when none is found rather than skip.
- `pnpm test` from this directory. `REPORT_PREVIEW_DIR=<dir> pnpm vitest run test/preview.test.ts`
  writes every fixture's HTML and PDF for a look (`pdftoppm -r 80 -png` for page images).

## Module format

The package is CommonJS like `packages/contracts` (no `"type": "module"`): the server loads it in
process for `AGENCY_REPORTS_RENDERER=inline` under `tsx`, and an ES module importing the CommonJS
contracts source there cannot see its named exports. The Lambda bundle is still ESM
(`scripts/build-lambda.mjs` emits `index.mjs`), and `src/pdf/fonts.ts` falls back from
`import.meta.url` to `__filename`.
