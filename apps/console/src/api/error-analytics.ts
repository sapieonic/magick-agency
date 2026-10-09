import { trackApiErrorEvent, type AnalyticsPath } from '../analytics/events';

const UUID_LIKE_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONGO_OBJECT_ID_SEGMENT_RE = /^[0-9a-f]{24}$/i;
const ULID_SEGMENT_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const CUID_LIKE_SEGMENT_RE = /^(?=.{16,}$)(?=.*\d)[a-z][a-z0-9]+$/i;
const PREFIXED_ID_SEGMENT_RE =
  /^[a-z][a-z0-9]{1,31}_(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{5,}$/i;
const TOKEN_CHAR_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const EMAIL_LIKE_SEGMENT_RE = /^[^/]+@[^/]+\.[^/]+$/i;
const LONG_NUMERIC_SEGMENT_RE = /^\d{6,}$/;
const PHONE_LIKE_SEGMENT_RE = /^\+?\d[\d().\-\s]{6,}\d$/;

function decodeSegmentForDetection(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  return Array.from(counts.values()).reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function isHighEntropyTokenLikeSegment(segment: string): boolean {
  if (
    segment.length < 20
    || !TOKEN_CHAR_SEGMENT_RE.test(segment)
    || !/[A-Za-z]/.test(segment)
    || !/\d/.test(segment)
  ) {
    return false;
  }

  const compactSegment = segment.replace(/[-_]/g, '');
  return compactSegment.length >= 16 && shannonEntropy(compactSegment) >= 3.5;
}

function sanitizeSegment(segment: string): string {
  const detectionSegment = decodeSegmentForDetection(segment);

  if (
    UUID_LIKE_SEGMENT_RE.test(detectionSegment)
    || MONGO_OBJECT_ID_SEGMENT_RE.test(detectionSegment)
    || ULID_SEGMENT_RE.test(detectionSegment)
    || CUID_LIKE_SEGMENT_RE.test(detectionSegment)
    || PREFIXED_ID_SEGMENT_RE.test(detectionSegment)
    || EMAIL_LIKE_SEGMENT_RE.test(detectionSegment)
    || LONG_NUMERIC_SEGMENT_RE.test(detectionSegment)
    || PHONE_LIKE_SEGMENT_RE.test(detectionSegment)
    || isHighEntropyTokenLikeSegment(detectionSegment)
  ) {
    return ':id';
  }
  return segment;
}

export function safeAnalyticsPath(url: string): AnalyticsPath {
  let pathname: string;

  try {
    pathname = new URL(url, window.location.origin).pathname;
  } catch {
    pathname = url.split('?')[0] ?? url;
  }

  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const sanitizedPath = normalizedPath
    .split('/')
    .map((segment, index) => (index === 0 ? segment : sanitizeSegment(segment)))
    .join('/')
    .replace(/\/{2,}/g, '/');

  return sanitizedPath as AnalyticsPath;
}

export function captureApiError(url: string, res: Response): void {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  trackApiErrorEvent({
    status: res.status,
    path: safeAnalyticsPath(url),
    request_id: requestId,
  });
}
