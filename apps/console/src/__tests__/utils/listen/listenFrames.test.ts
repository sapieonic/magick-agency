import { describe, it, expect } from 'vitest';
import {
  encodeListenClientFrame,
  listenCloseOutcome,
  parseListenAudio,
  parseListenControl,
  parseListenMessage,
  terminalEndReason,
} from '../../../utils/listen/listenFrames';
import { AGENCY_LISTEN_CLOSE, AGENCY_LISTEN_END_CLOSE, AGENCY_LISTEN_END_REASONS } from '../../../types/live-calls';

/**
 * The listener socket's wire as the console reads it (`docs/listening.md` §3): a binary message is
 * one tag byte and 160 bytes of A-law; a text message is a control frame; anything else is
 * ignored. And what each close means.
 */

function audio(tag: number, fill = 0xd5, length = 161): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = tag;
  bytes.fill(fill, 1);
  return bytes.buffer;
}

describe('audio messages', () => {
  it('reads the customer (0x01) and the agent (0x02) leg, 160 bytes each, without copying', () => {
    const buffer = audio(0x01, 0x2a);
    const customer = parseListenAudio(buffer)!;
    expect(customer.leg).toBe('customer');
    expect(customer.frame.byteLength).toBe(160);
    expect(customer.frame.buffer).toBe(buffer);
    expect(customer.frame.byteOffset).toBe(1);
    expect(customer.frame[0]).toBe(0x2a);
    expect(parseListenAudio(audio(0x02))!.leg).toBe('agent');
  });

  it('reads a typed-array view as well as an ArrayBuffer', () => {
    const outer = new Uint8Array(170);
    outer[5] = 0x02;
    expect(parseListenAudio(outer.subarray(5, 166))?.leg).toBe('agent');
  });

  it.each([
    ['an unknown tag', audio(0x03)],
    ['a zero tag', audio(0x00)],
    ['a short message', audio(0x01, 0xd5, 160)],
    ['a long message', audio(0x01, 0xd5, 162)],
    ['an empty message', new ArrayBuffer(0)],
  ])('ignores %s', (_name, data) => {
    expect(parseListenAudio(data)).toBeNull();
    expect(parseListenMessage(data)).toBeNull();
  });

  it('ignores a Blob or anything else that is not bytes', () => {
    expect(parseListenMessage({})).toBeNull();
    expect(parseListenMessage(null)).toBeNull();
    expect(parseListenMessage(161)).toBeNull();
  });
});

describe('control frames', () => {
  it('reads ready, ended and pong', () => {
    expect(parseListenControl(JSON.stringify({ event: 'ready', listen_id: 'l-1', call_id: 'c-1', format: 'alaw8', frame_bytes: 160 }))).toEqual({
      event: 'ready',
      listen_id: 'l-1',
      call_id: 'c-1',
      format: 'alaw8',
      frame_bytes: 160,
    });
    expect(parseListenControl('{"event":"ended","reason":"call_ended"}')).toEqual({ event: 'ended', reason: 'call_ended' });
    expect(parseListenControl('{"event":"pong","ts":5,"server_ts":9}')).toEqual({ event: 'pong', ts: 5, server_ts: 9 });
    expect(parseListenControl('{"event":"pong","server_ts":9}')).toEqual({ event: 'pong', server_ts: 9 });
  });

  it('reads every end reason in the contract', () => {
    for (const reason of AGENCY_LISTEN_END_REASONS) {
      expect(parseListenControl(JSON.stringify({ event: 'ended', reason }))).toEqual({ event: 'ended', reason });
    }
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['an unknown event', '{"event":"whisper"}'],
    ['ready in another format', '{"event":"ready","listen_id":"l","call_id":"c","format":"pcm16","frame_bytes":160}'],
    ['ready with another frame size', '{"event":"ready","listen_id":"l","call_id":"c","format":"alaw8","frame_bytes":320}'],
    ['ready without ids', '{"event":"ready","format":"alaw8","frame_bytes":160}'],
    ['ended with an unknown reason', '{"event":"ended","reason":"bored"}'],
    ['pong without server_ts', '{"event":"pong","ts":1}'],
  ])('ignores %s', (_name, text) => {
    expect(parseListenControl(text)).toBeNull();
    expect(parseListenMessage(text)).toBeNull();
  });

  it('routes text to control and bytes to audio', () => {
    expect(parseListenMessage('{"event":"pong","server_ts":1}')?.kind).toBe('control');
    expect(parseListenMessage(audio(1))?.kind).toBe('audio');
  });

  it('writes ping and stop as the contract names them', () => {
    expect(JSON.parse(encodeListenClientFrame({ event: 'ping', ts: 12 }))).toEqual({ event: 'ping', ts: 12 });
    expect(JSON.parse(encodeListenClientFrame({ event: 'stop' }))).toEqual({ event: 'stop' });
  });
});

describe('what a close means', () => {
  it.each([
    [AGENCY_LISTEN_CLOSE.NORMAL, 'call_ended', { kind: 'call_ended' }],
    [AGENCY_LISTEN_CLOSE.NORMAL, '', { kind: 'call_ended' }],
    [AGENCY_LISTEN_CLOSE.NORMAL, 'listener_stopped', { kind: 'stopped' }],
    [AGENCY_LISTEN_CLOSE.GOING_AWAY, 'server_shutdown', { kind: 'reconnect' }],
    [AGENCY_LISTEN_CLOSE.TOKEN_REJECTED, '', { kind: 'reconnect' }],
    [AGENCY_LISTEN_CLOSE.FORBIDDEN, 'permission_revoked', { kind: 'revoked' }],
    [AGENCY_LISTEN_CLOSE.CALL_GONE, 'listen_call_not_live', { kind: 'call_ended' }],
    [AGENCY_LISTEN_CLOSE.HEARTBEAT_TIMEOUT, 'send_backlog', { kind: 'reconnect' }],
    [AGENCY_LISTEN_CLOSE.SUPERSEDED, 'superseded', { kind: 'superseded' }],
    [AGENCY_LISTEN_CLOSE.LIMIT, 'listen_limit_call', { kind: 'refused', code: 'listen_limit_call' }],
    [AGENCY_LISTEN_CLOSE.LIMIT, 'whatever', { kind: 'refused', code: null }],
    [AGENCY_LISTEN_CLOSE.INVALID_UPGRADE, '', { kind: 'refused', code: null }],
    [AGENCY_LISTEN_CLOSE.INTERNAL_ERROR, 'tap_error', { kind: 'internal' }],
    // The server could not check the supervisor's access for too long (LS21): stop, offer Try
    // again; neither "no longer have access" nor a reconnect loop.
    [AGENCY_LISTEN_CLOSE.ACCESS_UNVERIFIED, 'access_unverified', { kind: 'unverified' }],
    [4503, '', { kind: 'unverified' }],
    // A server closing without an `ended` frame (one process shutting down, LS16 g: the WebSocket
    // plugin closes every socket with no code, which the browser reports as 1005) is a drop.
    [1005, '', { kind: 'reconnect' }],
    [1006, '', { kind: 'reconnect' }],
    [4999, '', { kind: 'reconnect' }],
  ])('%i %s', (code, reason, outcome) => {
    expect(listenCloseOutcome(code, reason)).toEqual(outcome);
  });

  it('agrees with the server’s code for every end reason it sends', () => {
    // Each reason the server closes with lands where its `ended` frame would.
    for (const [reason, code] of Object.entries(AGENCY_LISTEN_END_CLOSE)) {
      const byClose = listenCloseOutcome(code, reason);
      const byFrame = terminalEndReason(reason as keyof typeof AGENCY_LISTEN_END_CLOSE);
      if (byFrame) expect(byClose, reason).toEqual(byFrame);
      else expect(['reconnect', 'internal'], reason).toContain(byClose.kind);
    }
  });

  it('moves at once only on the reasons that end the session for good', () => {
    expect(terminalEndReason('call_ended')).toEqual({ kind: 'call_ended' });
    expect(terminalEndReason('listener_stopped')).toEqual({ kind: 'stopped' });
    expect(terminalEndReason('permission_revoked')).toEqual({ kind: 'revoked' });
    expect(terminalEndReason('superseded')).toEqual({ kind: 'superseded' });
    expect(terminalEndReason('access_unverified')).toEqual({ kind: 'unverified' });
    for (const reason of ['listener_disconnected', 'send_backlog', 'tap_error', 'server_shutdown', 'server_restarted'] as const) {
      expect(terminalEndReason(reason), reason).toBeNull();
    }
  });
});
