import pino from 'pino';
import type { TransportSingleOptions } from 'pino';
import { getLogContext } from './log-context.js';
import { maskPiiValue } from './crypto.js';
import { APP_VERSION } from './version.js';
import { SERVICE_NAME } from './service.js';
// `scrubMediaUrl` and its key set live in `url-scrub.ts` (see its header).
import { isSecretQueryKey, scrubMediaUrl } from './url-scrub.js';

export { scrubMediaUrl };

const isProduction = process.env['NODE_ENV'] === 'production';

// Raw caller transcripts are PII (debt-collection speech). They are never
// written to the app logs unless this is explicitly opted in for local
// debugging. Read directly from env (like the flags above) so the AI adapters
// can gate transcript fields without eagerly loading the full app config.
export const CAPTURE_TRANSCRIPTS = process.env['LOG_CAPTURE_TRANSCRIPTS'] === 'true';

/**
 * No OTLP transport here (Manas, 2026-10-09; decision "Log export"): with the SDK started
 * (`apps/server/src/instrumentation.ts`), `PinoInstrumentation` already sends every record to the
 * SDK's log exporter, so a `pino-opentelemetry-transport` target would ship each line a second
 * time. Logs leave the process only through the SDK, under the same resource as traces and
 * metrics.
 */
function buildTransport(): TransportSingleOptions | undefined {
  if (!isProduction) {
    return { target: 'pino-pretty', options: { colorize: true } };
  }

  // Production: plain JSON to stdout
  return undefined;
}

// Headers carrying secrets that must never be logged in plaintext. Fastify's
// request logging serializes the full headers object, so without this every
// incoming request would leak the caller's API key / bearer token to log storage.
const SECRET_HEADER_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers.authorization',
  // Some setups title-case header keys; redact both forms defensively.
  'req.headers["X-API-Key"]',
  'req.headers.Authorization',
];

// PII-bearing log fields. The app logger (unlike the audit logger) historically
// only redacted the auth headers above, so phone numbers, emails and full
// provider payloads (names, amounts) reached log storage — a DPDP/GDPR problem
// for debt-collection data. These paths route the matched values through
// `logCensor`: contact identifiers are value-masked (kept correlatable), while
// free-form payloads that embed arbitrary PII are dropped entirely.
//
// Contact identifiers — masked via `maskPiiValue` (phone/email shape only, so a
// state enum on `from`/`to` survives). Both top-level and one-level-nested forms
// are listed because pino's `*` wildcard matches a single level only.
const PII_CONTACT_PATHS = [
  'to', 'from', 'rawFrom', 'rawTo',
  'phone', 'to_phone', 'from_phone',
  'email', 'to_email', 'from_email',
  'caller', 'callee', 'inbound_from', 'inbound_to',
  '*.to', '*.from', '*.rawFrom', '*.rawTo',
  '*.phone', '*.to_phone', '*.from_phone',
  '*.email', '*.to_email', '*.from_email',
  '*.caller', '*.callee', '*.inbound_from', '*.inbound_to',
];

// App-controlled payloads that embed unstructured PII (recipient, names,
// amounts, arbitrary template variables) — fully redacted; value-masking can't
// reliably catch free-form names/amounts inside them.
const PII_PAYLOAD_PATHS = ['requestBody', 'payload', '*.requestBody', '*.payload'];
const FULL_REDACT_KEYS = new Set(['requestbody', 'payload']);

// Provider/request bodies (e.g. telephony webhook callbacks) — these carry PII
// (From/To/Caller phone numbers, any key casing) alongside non-PII operational
// fields (call status, SIDs, timestamps). An object body is deep value-masked so
// the PII-shaped leaves are hidden while the rest survives for debugging; a
// string body (a serialized blob, e.g. an SQS message) can't be selectively
// masked, so it's dropped entirely.
const PII_BODY_PATHS = ['body', '*.body'];
const DEEP_MASK_KEYS = new Set(['body']);

export const REDACT_PATHS = [
  ...SECRET_HEADER_PATHS,
  ...PII_CONTACT_PATHS,
  ...PII_PAYLOAD_PATHS,
  ...PII_BODY_PATHS,
];

/**
 * Single censor for all redacted paths (pino allows only one). Auth headers and
 * free-form app payloads are fully redacted; provider bodies are deep
 * value-masked; contact identifiers are value-masked so logs stay correlatable.
 * The path's leaf key decides which applies.
 */
export function logCensor(value: unknown, path: string[]): unknown {
  const key = (path[path.length - 1] ?? '').toLowerCase();
  if (path.includes('headers') || key === 'authorization' || key === 'x-api-key') {
    return '[REDACTED]';
  }
  if (FULL_REDACT_KEYS.has(key)) {
    return '[REDACTED]';
  }
  if (DEEP_MASK_KEYS.has(key)) {
    // A serialized blob (string) can't be selectively masked → drop it.
    return typeof value === 'string' ? '[REDACTED]' : maskPiiValue(value);
  }
  return maskPiiValue(value);
}

/**
 * The request serializer used by the app logger. Wraps (never replaces) pino's
 * standard req serializer so every field Fastify's request logging relies on is
 * preserved, then scrubs credentials out of the URL and the parsed query/params.
 * `redact` can't do this: it censors whole values by path, and `req.url` must
 * stay readable apart from the secret.
 *
 * Exported so the redaction can be tested against the REAL serializer rather than
 * a re-implementation — the leak lives inside Fastify's own logging, invisible to
 * ordinary assertions. Mutates only the serialized snapshot — never the live
 * Fastify request — so auth/routing are unaffected.
 */
export function serializeRequest(request: unknown): Record<string, unknown> {
  const serialized = pino.stdSerializers.req(request as never) as unknown as Record<string, unknown>;
  if (typeof serialized['url'] === 'string') {
    serialized['url'] = scrubMediaUrl(serialized['url'] as string);
  }
  // Parsed query/params are serialized as their own fields, so scrubbing the URL
  // alone is not enough — verified against pino.stdSerializers.req output.
  for (const bag of ['query', 'params'] as const) {
    const value = serialized[bag];
    if (!value || typeof value !== 'object') continue;
    const src = value as Record<string, unknown>;
    let patched: Record<string, unknown> | null = null;
    for (const key of Object.keys(src)) {
      if (!isSecretQueryKey(key)) continue;
      if (!patched) patched = { ...src };
      patched[key] = '[REDACTED]';
    }
    if (patched) serialized[bag] = patched;
  }
  return serialized;
}

export const logger = pino({
  level: process.env['LOG_LEVEL'] || 'info',
  transport: buildTransport(),
  base: { service: SERVICE_NAME, version: APP_VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Inject the ambient async-scoped context (tenantId, accountId, …) into every
  // log line — across all child/component loggers — so identifiers become
  // first-class filterable fields in Grafana without each call site repeating
  // them. When no context is set (startup, background jobs), it contributes
  // nothing.
  //
  // Precedence (pino semantics, verified): fields passed explicitly to a log
  // call override the mixin; the mixin in turn overrides child-logger bindings
  // on a key collision. The latter is safe for these identifiers because the
  // ambient context and any per-logger tenant/account binding (e.g.
  // call-session) both derive from the same authenticated request — or are
  // absent together — so they never disagree.
  mixin() {
    return getLogContext() ?? {};
  },
  redact: {
    paths: REDACT_PATHS,
    censor: logCensor,
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: serializeRequest,
    res: pino.stdSerializers.res,
  },
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
