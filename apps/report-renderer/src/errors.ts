import type { ReportRendererFailureCode } from '@magick-agency/contracts/reports';

/**
 * A render failure with the run failure code it maps to. Anything thrown inside a render stage
 * that is not one of these is mapped by the stage (`render_failed` while drawing,
 * `upload_failed` while writing); a `RenderFailure` keeps its own code (a detail file that will
 * not parse is `dataset_unreadable` even though it is read while the workbook is drawn).
 */
export class RenderFailure extends Error {
  readonly code: ReportRendererFailureCode;

  constructor(code: ReportRendererFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RenderFailure';
    this.code = code;
  }
}

/** A short, PII-free description of an error for logs and the callback's `message`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}
