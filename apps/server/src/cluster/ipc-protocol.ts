/**
 * The wire format between the primary and the processes it forks (`docs/scaling.md` §4):
 * one envelope over Node's `child_process` channel (JSON serialisation, so a socket handle
 * can ride along), and one decoder per message type.
 *
 * ── Decoders, in the pacing bus's pattern ───────────────────────────────────
 * Every type has a decoder `(raw: unknown) => Body | null`, like
 * `parsePacingInvalidationEvent`: a malformed body or an unknown type decodes to null and
 * is dropped (an event) or answered `malformed` / `unsupported` (a request), never thrown
 * on. Both ends run the same bundle, so a mismatch is a bug, not a rolling upgrade; it is
 * still refused rather than trusted, because these messages drive dials and shutdowns.
 *
 * ── What may cross ──────────────────────────────────────────────────────────
 * Plain JSON: ids, numbers, strings, and records whose dates the decoder revives. Never a
 * callback, a class instance or a socket's audio. No media frame ever crosses IPC.
 */
import { parsePacingInvalidationEvent, type PacingInvalidationEvent } from '../agency/pacing/invalidation-bus.js';
import { CHILD_ROLES, type ChildRole } from './roles.js';

export const IPC_PROTOCOL_VERSION = 1 as const;

export const IPC_ERROR_CODES = [
  /** No response within the request's deadline. The receiver may still act on it. */
  'timeout',
  /** The channel closed (the other process exited) with the request outstanding. */
  'gone',
  /** Not sent: the channel is closed, or the in-flight cap is reached. */
  'refused',
  /** The receiver has no handler for this request type. */
  'unsupported',
  /** The request or response body did not decode. */
  'malformed',
  /** The receiver's handler threw. */
  'handler_error',
] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcEventEnvelope {
  v: typeof IPC_PROTOCOL_VERSION;
  kind: 'event';
  type: string;
  body: unknown;
  /** W3C `traceparent` of the sender's active span, when there is one. */
  tp?: string;
}

export interface IpcRequestEnvelope {
  v: typeof IPC_PROTOCOL_VERSION;
  kind: 'req';
  id: number;
  type: string;
  body: unknown;
  /** The sender gives up after this long; the receiver may use it to bound its own work. */
  deadlineMs: number;
  tp?: string;
}

export type IpcResponseEnvelope =
  | { v: typeof IPC_PROTOCOL_VERSION; kind: 'res'; id: number; ok: true; body: unknown }
  | { v: typeof IPC_PROTOCOL_VERSION; kind: 'res'; id: number; ok: false; error: { code: IpcErrorCode; message: string } };

export type IpcEnvelope = IpcEventEnvelope | IpcRequestEnvelope | IpcResponseEnvelope;

const MAX_TYPE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isType = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_TYPE_LENGTH && /^[a-z][a-z0-9_.]*$/.test(v);

/** Decode the envelope only (not the body). Null for anything that is not one. */
export function parseIpcEnvelope(raw: unknown): IpcEnvelope | null {
  if (!isRecord(raw) || raw['v'] !== IPC_PROTOCOL_VERSION) return null;
  const tp = typeof raw['tp'] === 'string' && raw['tp'].length <= 128 ? raw['tp'] : undefined;
  switch (raw['kind']) {
    case 'event':
      if (!isType(raw['type'])) return null;
      return { v: 1, kind: 'event', type: raw['type'], body: raw['body'], ...(tp ? { tp } : {}) };
    case 'req':
      if (!isPositiveInt(raw['id']) || !isType(raw['type']) || !isPositiveInt(raw['deadlineMs'])) return null;
      return { v: 1, kind: 'req', id: raw['id'], type: raw['type'], body: raw['body'], deadlineMs: raw['deadlineMs'], ...(tp ? { tp } : {}) };
    case 'res': {
      if (!isPositiveInt(raw['id'])) return null;
      if (raw['ok'] === true) return { v: 1, kind: 'res', id: raw['id'], ok: true, body: raw['body'] };
      if (raw['ok'] !== false || !isRecord(raw['error'])) return null;
      const code = raw['error']['code'];
      const message = raw['error']['message'];
      if (!(IPC_ERROR_CODES as readonly unknown[]).includes(code) || typeof message !== 'string') return null;
      return {
        v: 1, kind: 'res', id: raw['id'], ok: false,
        error: { code: code as IpcErrorCode, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
      };
    }
    default:
      return null;
  }
}

// ─── Bodies ─────────────────────────────────────────────────────────────────

/** A child announcing it has booted and will now take work. */
export interface ReadyBody {
  role: ChildRole;
  slot: number;
  pid: number;
}

/** One analysis process's vendor rate-limit pause, to be applied by every other one (D10). */
export interface RatePausedBody {
  /** Epoch ms the pause ends. Same host, same clock. */
  untilMs: number;
  /** How many consecutive openings this is, so the others escalate in step. */
  consecutive: number;
}

export interface ShutdownBody {
  /** How long the child has before the primary stops waiting and kills it. */
  graceMs: number;
}

export interface HealthBody {
  role: ChildRole;
  slot: number;
  pid: number;
  /** Event-loop utilisation since the previous ping, 0..1. */
  elu: number;
  /** Units of work in flight: analysis jobs, or live calls on a media worker. */
  inFlight: number;
  /** An analysis process: how long its vendor rate-limit pause has left (0 when not paused). */
  pausedForMs: number;
  draining: boolean;
}

export type EmptyBody = Record<string, never>;

export function parseEmptyBody(raw: unknown): EmptyBody | null {
  return raw === undefined || isRecord(raw) ? {} : null;
}

export function parseReadyBody(raw: unknown): ReadyBody | null {
  if (!isRecord(raw)) return null;
  const { role, slot, pid } = raw;
  if (!(CHILD_ROLES as readonly unknown[]).includes(role) || !isNonNegativeInt(slot) || !isPositiveInt(pid)) return null;
  return { role: role as ChildRole, slot, pid };
}

export function parseRatePausedBody(raw: unknown): RatePausedBody | null {
  if (!isRecord(raw)) return null;
  const { untilMs, consecutive } = raw;
  if (!isPositiveInt(untilMs) || !isPositiveInt(consecutive) || consecutive > 64) return null;
  return { untilMs, consecutive };
}

export function parseShutdownBody(raw: unknown): ShutdownBody | null {
  if (!isRecord(raw) || !isPositiveInt(raw['graceMs'])) return null;
  return { graceMs: raw['graceMs'] };
}

export function parseHealthBody(raw: unknown): HealthBody | null {
  if (!isRecord(raw)) return null;
  const { role, slot, pid, elu, inFlight, pausedForMs, draining } = raw;
  if (!(CHILD_ROLES as readonly unknown[]).includes(role) || !isNonNegativeInt(slot) || !isPositiveInt(pid)) return null;
  if (typeof elu !== 'number' || !(elu >= 0 && elu <= 1) || !isNonNegativeInt(inFlight)) return null;
  if (!isNonNegativeInt(pausedForMs) || typeof draining !== 'boolean') return null;
  return { role: role as ChildRole, slot, pid, elu, inFlight, pausedForMs, draining };
}

// ─── The catalogue ──────────────────────────────────────────────────────────

/** Fire-and-forget messages, either direction. */
export interface IpcEventMap {
  ready: ReadyBody;
  'analysis.wake': EmptyBody;
  'analysis.rate_paused': RatePausedBody;
  'pacing.invalidate': PacingInvalidationEvent;
}

/** Request and response bodies, by request type. */
export interface IpcRequestMap {
  'health.ping': { req: EmptyBody; res: HealthBody };
  shutdown: { req: ShutdownBody; res: EmptyBody };
}

export type IpcEventType = keyof IpcEventMap;
export type IpcRequestType = keyof IpcRequestMap;

type Decoder<T> = (raw: unknown) => T | null;

export const IPC_EVENT_DECODERS: { readonly [K in IpcEventType]: Decoder<IpcEventMap[K]> } = {
  ready: parseReadyBody,
  'analysis.wake': parseEmptyBody,
  'analysis.rate_paused': parseRatePausedBody,
  'pacing.invalidate': parsePacingInvalidationEvent,
};

export const IPC_REQUEST_DECODERS: {
  readonly [K in IpcRequestType]: { req: Decoder<IpcRequestMap[K]['req']>; res: Decoder<IpcRequestMap[K]['res']> };
} = {
  'health.ping': { req: parseEmptyBody, res: parseHealthBody },
  shutdown: { req: parseShutdownBody, res: parseEmptyBody },
};

/**
 * How long a sender waits for each request type unless the caller says otherwise. A
 * shutdown is bounded by its own body's grace plus a margin; see `IpcChannel.request`.
 */
export const IPC_DEFAULT_DEADLINES_MS: { readonly [K in IpcRequestType]: number } = {
  'health.ping': 1_000,
  shutdown: 35_000,
};

export function isIpcEventType(type: string): type is IpcEventType {
  return Object.prototype.hasOwnProperty.call(IPC_EVENT_DECODERS, type);
}

export function isIpcRequestType(type: string): type is IpcRequestType {
  return Object.prototype.hasOwnProperty.call(IPC_REQUEST_DECODERS, type);
}
