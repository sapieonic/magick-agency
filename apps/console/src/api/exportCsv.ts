// Shared CSV export downloader for the calls / static-calls export endpoints.
//
// PORT NOTE (magick-agency): only `outcomeReportFilename` is ported — the three
// agency outcome reports (activity, attempts, roster) name their downloads with
// it. The downloader itself (`downloadExportCsv`, `ExportFieldsError`,
// `ValidExportField`, `filenameFromContentDisposition`) served the AI calls /
// static-calls export endpoints, which are not ported.

/**
 * Build a safe `.csv` download name from a campaign / job name.
 * Strips path/control characters so the browser doesn't reject the download.
 */
export function outcomeReportFilename(
  name: string | null | undefined,
  fallback: string,
): string {
  const fallbackCsv = fallback.toLowerCase().endsWith('.csv') ? fallback : `${fallback}.csv`;
  const raw = (name ?? '').trim();
  if (!raw) return fallbackCsv;
  const safe = raw
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 180)
    .trim();
  if (!safe) return fallbackCsv;
  return safe.toLowerCase().endsWith('.csv') ? safe : `${safe}.csv`;
}
