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
import type { AgencyStationServerFrame } from '@magick-agency/contracts/agency';
import { parsePacingInvalidationEvent, type PacingInvalidationEvent } from '../agency/pacing/invalidation-bus.js';
import type { DialCommand } from '../agency/dial-dispatcher.js';
import type { AgencyManualCallRecord } from '../db/models/agency.model.js';
import type { UnrecordedEnd } from '../agency/reaper.js';
import { CHILD_ROLES, type ChildRole } from './roles.js';
import { decodeDialCommand, decodeManualCallRecord } from './record-codecs.js';

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

/**
 * An upgraded socket handed to a media worker (`docs/scaling.md` §2.2), sent WITH the
 * socket handle. Not a request: the worker completes the handshake on the socket itself.
 */
export interface WsHandoff {
  v: typeof IPC_PROTOCOL_VERSION;
  kind: 'handoff';
  route: 'station' | 'pstn';
  method: 'GET';
  /** Path and query, verbatim. */
  url: string;
  httpVersion: string;
  /** Verbatim header pairs, so `x-forwarded-for`, `x-client` and `sec-websocket-*` survive. */
  rawHeaders: string[];
  /** Base64 of the bytes after the headers (usually empty). */
  head: string;
  /** The primary's request id, so both processes' lines for the upgrade join. */
  requestId: string;
}

export type IpcEnvelope = IpcEventEnvelope | IpcRequestEnvelope | IpcResponseEnvelope;

const MAX_HANDOFF_HEADERS = 256;

export function parseWsHandoff(raw: unknown): WsHandoff | null {
  if (!isRecord(raw) || raw['v'] !== IPC_PROTOCOL_VERSION || raw['kind'] !== 'handoff') return null;
  const { route, method, url, httpVersion, rawHeaders, head, requestId } = raw;
  if (route !== 'station' && route !== 'pstn') return null;
  if (method !== 'GET' || typeof url !== 'string' || !url.startsWith('/') || url.length > 8192) return null;
  if (typeof httpVersion !== 'string' || !/^1\.[01]$/.test(httpVersion)) return null;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.length > MAX_HANDOFF_HEADERS * 2) return null;
  if (!rawHeaders.every((h) => typeof h === 'string')) return null;
  if (typeof head !== 'string' || typeof requestId !== 'string' || requestId.length > 256) return null;
  return { v: 1, kind: 'handoff', route, method, url, httpVersion, rawHeaders: rawHeaders as string[], head, requestId };
}

const MAX_TYPE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isIdList = (v: unknown, max = 100_000): v is string[] => Array.isArray(v) && v.length <= max && v.every(isId);
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
  /** A media worker's replica id (the station ownership keys name it). */
  replicaId?: string;
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
  /** p99 event-loop delay since the previous ping, ms. */
  loopDelayP99Ms: number;
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
  const replicaId = raw['replicaId'];
  if (replicaId !== undefined && !isId(replicaId)) return null;
  return { role: role as ChildRole, slot, pid, ...(replicaId !== undefined ? { replicaId } : {}) };
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
  const { role, slot, pid, elu, inFlight, pausedForMs, loopDelayP99Ms, draining } = raw;
  if (!(CHILD_ROLES as readonly unknown[]).includes(role) || !isNonNegativeInt(slot) || !isPositiveInt(pid)) return null;
  if (typeof elu !== 'number' || !(elu >= 0 && elu <= 1) || !isNonNegativeInt(inFlight)) return null;
  if (!isNonNegativeInt(pausedForMs) || typeof draining !== 'boolean') return null;
  if (typeof loopDelayP99Ms !== 'number' || !(loopDelayP99Ms >= 0)) return null;
  return { role: role as ChildRole, slot, pid, elu, inFlight, pausedForMs, loopDelayP99Ms, draining };
}

// ─── Media worker bodies ────────────────────────────────────────────────────

export interface StationAttachedBody { sessionId: string; campaignId: string | null; replicaId: string }
export interface StationDetachedBody { sessionId: string }
export interface StationSnapshotBody { replicaId: string; sessions: Array<{ sessionId: string; campaignId: string | null }> }
export interface StationBroadcastBody { campaignId: string; frame: AgencyStationServerFrame }
export interface PacingRevokeBody { campaignId: string | null; upTo: number }
export interface AccountScopeBody { tenantId: string; accountId: string }
export interface AttemptIdsBody { attemptIds: string[] }
export interface DialExecuteBody { cmd: DialCommand; grant: number }
export interface CoreInjectBody { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers: Record<string, string>; payload?: string }
export interface CoreInjectAnswer { statusCode: number; headers: Record<string, string | string[]>; body: string }
export interface CarrierWebhookBody { callId: string; token: string | null; body: unknown }
export interface CarrierWebhookAnswer { statusCode: number; body: { status: boolean } }
export interface SessionBody { sessionId: string }
/** The slots one live call holds, so the primary can release them if its worker dies. */
export interface CallLease { callId: string; concurrencyKey: string; tenantId: string; accountId: string; provider: string }
export interface ReaperSnapshotBody {
  activeAttemptIds: string[];
  /** Attempts the worker's dialer could not write `ended`, each saying whether its dial's outcome is unknown. */
  unrecordedEnds: UnrecordedEnd[];
  manualActiveIds: string[];
  activeCallIds: string[];
  leases: CallLease[];
}
export interface ManualCallRowsBody { rows: AgencyManualCallRecord[] }
/** A media worker took or gave back a call's slots (`docs/scaling.md` §6.1). */
export type CallLeaseBody = { op: 'held'; lease: CallLease } | { op: 'released'; concurrencyKey: string };

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const nullableId = (v: unknown): v is string | null => v === null || isId(v);

export function parseStationAttached(raw: unknown): StationAttachedBody | null {
  if (!isRecord(raw) || !isId(raw['sessionId']) || !nullableId(raw['campaignId']) || !isId(raw['replicaId'])) return null;
  return { sessionId: raw['sessionId'], campaignId: raw['campaignId'], replicaId: raw['replicaId'] };
}
export function parseStationDetached(raw: unknown): StationDetachedBody | null {
  return isRecord(raw) && isId(raw['sessionId']) ? { sessionId: raw['sessionId'] } : null;
}
export function parseStationSnapshot(raw: unknown): StationSnapshotBody | null {
  if (!isRecord(raw) || !isId(raw['replicaId']) || !Array.isArray(raw['sessions'])) return null;
  const sessions: StationSnapshotBody['sessions'] = [];
  for (const s of raw['sessions']) {
    if (!isRecord(s) || !isId(s['sessionId']) || !nullableId(s['campaignId'])) return null;
    sessions.push({ sessionId: s['sessionId'], campaignId: s['campaignId'] });
  }
  return { replicaId: raw['replicaId'], sessions };
}
export function parseStationBroadcast(raw: unknown): StationBroadcastBody | null {
  if (!isRecord(raw) || !isId(raw['campaignId']) || !isRecord(raw['frame']) || typeof raw['frame']['event'] !== 'string') return null;
  return { campaignId: raw['campaignId'], frame: raw['frame'] as unknown as AgencyStationServerFrame };
}
export function parsePacingRevoke(raw: unknown): PacingRevokeBody | null {
  if (!isRecord(raw) || !nullableId(raw['campaignId']) || !isNonNegativeInt(raw['upTo'])) return null;
  return { campaignId: raw['campaignId'], upTo: raw['upTo'] };
}
export function parseAccountScope(raw: unknown): AccountScopeBody | null {
  return isRecord(raw) && isId(raw['tenantId']) && isId(raw['accountId']) ? { tenantId: raw['tenantId'], accountId: raw['accountId'] } : null;
}
export function parseAttemptIds(raw: unknown): AttemptIdsBody | null {
  return isRecord(raw) && isIdList(raw['attemptIds']) ? { attemptIds: raw['attemptIds'] } : null;
}
export function parseDialExecute(raw: unknown): DialExecuteBody | null {
  if (!isRecord(raw) || !isNonNegativeInt(raw['grant'])) return null;
  const cmd = decodeDialCommand(raw['cmd']);
  return cmd ? { cmd, grant: raw['grant'] } : null;
}
function isValueRecord(v: unknown, values: (x: unknown) => boolean): boolean {
  return isRecord(v) && Object.values(v).every(values);
}
export function parseCoreInject(raw: unknown): CoreInjectBody | null {
  if (!isRecord(raw)) return null;
  const { method, url, headers, payload } = raw;
  if (!(HTTP_METHODS as readonly unknown[]).includes(method) || typeof url !== 'string' || !url.startsWith('/api/v1/')) return null;
  if (!isValueRecord(headers, (x) => typeof x === 'string')) return null;
  if (payload !== undefined && typeof payload !== 'string') return null;
  return { method: method as CoreInjectBody['method'], url, headers: headers as Record<string, string>, ...(payload !== undefined ? { payload } : {}) };
}
export function parseCoreInjectAnswer(raw: unknown): CoreInjectAnswer | null {
  if (!isRecord(raw) || !isNonNegativeInt(raw['statusCode']) || typeof raw['body'] !== 'string') return null;
  if (!isValueRecord(raw['headers'], (x) => typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string')))) return null;
  return { statusCode: raw['statusCode'], headers: raw['headers'] as Record<string, string | string[]>, body: raw['body'] };
}
export function parseCarrierWebhook(raw: unknown): CarrierWebhookBody | null {
  if (!isRecord(raw) || !isId(raw['callId'])) return null;
  const token = raw['token'];
  if (token !== null && typeof token !== 'string') return null;
  return { callId: raw['callId'], token, body: raw['body'] };
}
export function parseCarrierWebhookAnswer(raw: unknown): CarrierWebhookAnswer | null {
  if (!isRecord(raw) || !isNonNegativeInt(raw['statusCode']) || !isRecord(raw['body']) || typeof raw['body']['status'] !== 'boolean') return null;
  return { statusCode: raw['statusCode'], body: { status: raw['body']['status'] } };
}
export function parseSessionBody(raw: unknown): SessionBody | null {
  return isRecord(raw) && isId(raw['sessionId']) ? { sessionId: raw['sessionId'] } : null;
}
function parseUnrecordedEnds(raw: unknown): UnrecordedEnd[] | null {
  if (!Array.isArray(raw) || raw.length > 100_000) return null;
  const out: UnrecordedEnd[] = [];
  for (const e of raw) {
    if (!isRecord(e) || !isId(e['attemptId']) || typeof e['dialOutcomeUnknown'] !== 'boolean') return null;
    out.push({ attemptId: e['attemptId'], dialOutcomeUnknown: e['dialOutcomeUnknown'] });
  }
  return out;
}
export function parseReaperSnapshot(raw: unknown): ReaperSnapshotBody | null {
  if (!isRecord(raw)) return null;
  const { activeAttemptIds, manualActiveIds, activeCallIds, leases } = raw;
  const unrecordedEnds = parseUnrecordedEnds(raw['unrecordedEnds']);
  if (!isIdList(activeAttemptIds) || !unrecordedEnds || !isIdList(manualActiveIds) || !isIdList(activeCallIds)) return null;
  if (!Array.isArray(leases)) return null;
  const out: CallLease[] = [];
  for (const l of leases) {
    if (!isRecord(l) || !isId(l['callId']) || !isId(l['concurrencyKey']) || !isId(l['tenantId']) || !isId(l['accountId']) || !isId(l['provider'])) return null;
    out.push({ callId: l['callId'], concurrencyKey: l['concurrencyKey'], tenantId: l['tenantId'], accountId: l['accountId'], provider: l['provider'] });
  }
  return { activeAttemptIds, unrecordedEnds, manualActiveIds, activeCallIds, leases: out };
}
export function parseCallLease(raw: unknown): CallLeaseBody | null {
  if (!isRecord(raw)) return null;
  if (raw['op'] === 'released') return isId(raw['concurrencyKey']) ? { op: 'released', concurrencyKey: raw['concurrencyKey'] } : null;
  if (raw['op'] !== 'held') return null;
  const snap = parseReaperSnapshot({ activeAttemptIds: [], unrecordedEnds: [], manualActiveIds: [], activeCallIds: [], leases: [raw['lease']] });
  return snap ? { op: 'held', lease: snap.leases[0]! } : null;
}

export function parseManualCallRows(raw: unknown): ManualCallRowsBody | null {
  if (!isRecord(raw) || !Array.isArray(raw['rows'])) return null;
  const rows: AgencyManualCallRecord[] = [];
  for (const r of raw['rows']) {
    const row = decodeManualCallRecord(r);
    if (!row) return null;
    rows.push(row);
  }
  return { rows };
}

// ─── The catalogue ──────────────────────────────────────────────────────────

/** Fire-and-forget messages, either direction. */
export interface IpcEventMap {
  ready: ReadyBody;
  'analysis.wake': EmptyBody;
  'analysis.rate_paused': RatePausedBody;
  'pacing.invalidate': PacingInvalidationEvent;
  'pacing.revoke': PacingRevokeBody;
  'station.attached': StationAttachedBody;
  'station.detached': StationDetachedBody;
  'station.snapshot': StationSnapshotBody;
  'station.broadcast': StationBroadcastBody;
  'concurrency.invalidate': AccountScopeBody;
  'reaper.forget_unrecorded': AttemptIdsBody;
  'voice.wake_self_heal': EmptyBody;
  'call.lease': CallLeaseBody;
}

/** Request and response bodies, by request type. */
export interface IpcRequestMap {
  'health.ping': { req: EmptyBody; res: HealthBody };
  shutdown: { req: ShutdownBody; res: EmptyBody };
  'dial.execute': { req: DialExecuteBody; res: EmptyBody };
  'core.inject': { req: CoreInjectBody; res: CoreInjectAnswer };
  'carrier.webhook': { req: CarrierWebhookBody; res: CarrierWebhookAnswer };
  'agent.return_reserved': { req: SessionBody; res: EmptyBody };
  'reaper.snapshot': { req: EmptyBody; res: ReaperSnapshotBody };
  'softphone.closed_by_sweep': { req: ManualCallRowsBody; res: EmptyBody };
}

export type IpcEventType = keyof IpcEventMap;
export type IpcRequestType = keyof IpcRequestMap;

type Decoder<T> = (raw: unknown) => T | null;

export const IPC_EVENT_DECODERS: { readonly [K in IpcEventType]: Decoder<IpcEventMap[K]> } = {
  ready: parseReadyBody,
  'analysis.wake': parseEmptyBody,
  'analysis.rate_paused': parseRatePausedBody,
  'pacing.invalidate': parsePacingInvalidationEvent,
  'pacing.revoke': parsePacingRevoke,
  'station.attached': parseStationAttached,
  'station.detached': parseStationDetached,
  'station.snapshot': parseStationSnapshot,
  'station.broadcast': parseStationBroadcast,
  'concurrency.invalidate': parseAccountScope,
  'reaper.forget_unrecorded': parseAttemptIds,
  'voice.wake_self_heal': parseEmptyBody,
  'call.lease': parseCallLease,
};

export const IPC_REQUEST_DECODERS: {
  readonly [K in IpcRequestType]: { req: Decoder<IpcRequestMap[K]['req']>; res: Decoder<IpcRequestMap[K]['res']> };
} = {
  'health.ping': { req: parseEmptyBody, res: parseHealthBody },
  shutdown: { req: parseShutdownBody, res: parseEmptyBody },
  'dial.execute': { req: parseDialExecute, res: parseEmptyBody },
  'core.inject': { req: parseCoreInject, res: parseCoreInjectAnswer },
  'carrier.webhook': { req: parseCarrierWebhook, res: parseCarrierWebhookAnswer },
  'agent.return_reserved': { req: parseSessionBody, res: parseEmptyBody },
  'reaper.snapshot': { req: parseEmptyBody, res: parseReaperSnapshot },
  'softphone.closed_by_sweep': { req: parseManualCallRows, res: parseEmptyBody },
};

/**
 * How long a sender waits for each request type unless the caller says otherwise. A
 * shutdown is bounded by its own body's grace plus a margin; see `IpcChannel.request`.
 */
export const IPC_DEFAULT_DEADLINES_MS: { readonly [K in IpcRequestType]: number } = {
  'health.ping': 1_000,
  shutdown: 35_000,
  'dial.execute': 40_000,
  'core.inject': 15_000,
  'carrier.webhook': 10_000,
  'agent.return_reserved': 5_000,
  'reaper.snapshot': 5_000,
  'softphone.closed_by_sweep': 10_000,
};

export function isIpcEventType(type: string): type is IpcEventType {
  return Object.prototype.hasOwnProperty.call(IPC_EVENT_DECODERS, type);
}

export function isIpcRequestType(type: string): type is IpcRequestType {
  return Object.prototype.hasOwnProperty.call(IPC_REQUEST_DECODERS, type);
}
