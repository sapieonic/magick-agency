import { describe, it, expect } from 'vitest';
import { redactUrlTail } from '../../../../src/telephony/voicelink/voicelink.adapter.js';

const CALL_ID = '49a81ab6-de01-4b4b-b1d9-92db714c7781';
const TOKEN = '31d60c46-733e-5214-c0f4-ea49d95a1b83';

describe('redactUrlTail', () => {
  /**
   * The whole point: the dispatch log must be useful enough to diagnose a silent
   * call (host + route + callId visible) without printing the media token, which
   * is the credential guarding the media socket.
   */
  it('masks a trailing token segment but keeps host, route and callId', () => {
    const out = redactUrlTail(
      `wss://h.example/api/v1/static-media-stream/${CALL_ID}/${TOKEN}`,
      { tokenInLastSegment: true },
    );
    expect(out).toBe(`wss://h.example/api/v1/static-media-stream/${CALL_ID}/…`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(CALL_ID);
  });

  it('keeps a trailing callId intact (AI media-stream shape has no token)', () => {
    const out = redactUrlTail(`wss://h.example/api/v1/media-stream/${CALL_ID}`);
    expect(out).toBe(`wss://h.example/api/v1/media-stream/${CALL_ID}`);
  });

  /**
   * Legacy shape: the secret is in the query, and the trailing segment is the
   * callId — so the query goes and the callId stays.
   */
  it('redacts the query wholesale and keeps the trailing callId', () => {
    const out = redactUrlTail(`wss://h.example/api/v1/static-media-stream/${CALL_ID}?token=${TOKEN}`);
    expect(out).toBe(`wss://h.example/api/v1/static-media-stream/${CALL_ID}?…`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(CALL_ID);
  });

  it('never echoes an unparseable string (could itself contain the secret)', () => {
    expect(redactUrlTail('not a url')).toBe('<unparseable-url>');
    expect(redactUrlTail(`garbage-${TOKEN}`, { tokenInLastSegment: true })).not.toContain(TOKEN);
  });

  it('handles a pathless URL', () => {
    expect(redactUrlTail('wss://h.example')).toBe('wss://h.example');
    expect(redactUrlTail('wss://h.example', { tokenInLastSegment: true })).toBe('wss://h.example');
  });

  it('defaults to leaving the last segment alone', () => {
    expect(redactUrlTail('wss://h.example/api/v1/health'))
      .toBe('wss://h.example/api/v1/health');
  });

  /**
   * A token in a single-segment path must STILL be redacted. Losing the route from
   * a log line is cosmetic; printing a live media token is a credential leak.
   */
  it('redacts a token even when it is the only path segment', () => {
    expect(redactUrlTail(`wss://h.example/${TOKEN}`, { tokenInLastSegment: true }))
      .toBe('wss://h.example/…');
  });
});
