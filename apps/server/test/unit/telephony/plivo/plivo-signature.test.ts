// Plivo V3 callback signatures. Two independent oracles:
//  - fixed vectors: each signature below was computed by `computePlivoV3Signature` and
//    then ACCEPTED by `validateV3Signature` of Plivo's official Node SDK (plivo@4.79.0,
//    `dist/utils/v3Security.js`), run outside this repo, which also rejected each one
//    with a character changed;
//  - a literal port of that SDK function below (`sdkSignature`), its URL parser and
//    query handling included, checked against the module over a grid of URLs and params.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { parse as parseQs } from 'node:querystring';
import {
  computePlivoV3Signature,
  plivoV3SignedBase,
  verifyPlivoV3Signature,
} from '../../../../src/telephony/plivo/plivo-signature.js';

const TOKEN = 'MjQ1ZDM0YzE0NmQ0NjE3OGIwYzM5ZjA2ZTQ5YjZm';

const SDK_VECTORS: Array<{ method: 'GET' | 'POST'; url: string; params: Record<string, string>; nonce: string; base: string; sig: string }> = [
  {
    method: 'POST',
    url: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-status/1b4e28ba-2fa1-11d2-883f-0016d3cca427?token=tok_abc123&w=2',
    params: { CallUUID: 'a1b2c3d4-0000-4000-8000-000000000001', CallStatus: 'ringing', Event: 'Ring', From: '918035000001', To: '919812345678', Direction: 'outbound', RequestUUID: 'f0e1d2c3-0000-4000-8000-000000000002' },
    nonce: '05429567804466091622',
    base: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-status/1b4e28ba-2fa1-11d2-883f-0016d3cca427?token=tok_abc123&w=2.CallStatusringingCallUUIDa1b2c3d4-0000-4000-8000-000000000001DirectionoutboundEventRingFrom918035000001RequestUUIDf0e1d2c3-0000-4000-8000-000000000002To919812345678',
    sig: 'DaxDLOuvCpNV435B0mcOBbDC3NXeGApyuunWtqa2qbg=',
  },
  {
    method: 'POST',
    url: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-answer/1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    params: { CallUUID: 'x', CallStatus: 'in-progress' },
    nonce: '12345',
    base: 'https://srv.example.com/api/v1/webhooks/plivo/webrtc-answer/1b4e28ba-2fa1-11d2-883f-0016d3cca427?CallStatusin-progressCallUUIDx',
    sig: 'lba/1bVsJ3eZSRLaI1M85Z8wDA/fubXYCwKwUK02fdQ=',
  },
  {
    method: 'POST',
    url: 'https://srv.example.com:8443/hook?b=2&a=3&a=1&e=x%20y+z',
    params: {},
    nonce: 'n',
    base: 'https://srv.example.com:8443/hook?a=1&a=3&b=2&e=x y z',
    sig: 'y2qE2DZgcBzOpfK0FGh8GQrFSbSbz6M4uZpYKnLJZy0=',
  },
  {
    method: 'GET',
    url: 'https://srv.example.com/hook?z=1&a=2',
    params: { m: 'q' },
    nonce: 'n2',
    base: 'https://srv.example.com/hook?a=2&m=q&z=1',
    sig: 'CvJQ+wWIBcd3h7LPTm0KlFP3QJVuH3ZrLfT/PELHYy4=',
  },
];

// ─── A literal port of the SDK's v3Security.js (ASCII inputs) ───────────────
const LOOSE = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;
function sdkParse(uri: string) {
  const m = LOOSE.exec(uri)!;
  return { protocol: m[1] ?? '', host: m[6] ?? '', port: m[7] ?? '', path: m[9] ?? '', query: m[12] ?? '' };
}
function buildUrl(url: string, path: string): string {
  let built = url.endsWith('/') ? url.slice(0, -1) : url;
  if (path) built += path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`;
  return built;
}
function mapFromQuery(p1: Record<string, string | string[]>, p2: Record<string, string>) {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(p1)) { const v = p1[k]!; out[k] = Array.isArray(v) ? v : [v]; }
  for (const k of Object.keys(p2)) out[k] = (out[k] ?? []).concat([p2[k]!]);
  return out;
}
function sortedQuery(params: Record<string, string[]>): string {
  const q: string[] = [];
  for (const k of Object.keys(params).sort()) for (const v of params[k]!.sort()) q.push(`${k}=${v}`);
  return q.join('&');
}
function constructGetUrl(uri: string, params: Record<string, string>, emptyPost = true): string {
  const p = sdkParse(uri);
  const proto = p.protocol === '' ? 'http://' : `${p.protocol}://`;
  const proxy = p.port === '' ? p.host : `${p.host}:${p.port}`;
  let base = buildUrl(proto + proxy, p.path);
  const q = sortedQuery(mapFromQuery(parseQs(p.query) as Record<string, string | string[]>, params));
  if (q.length > 0 || !emptyPost) base += `?${q}`;
  if (q.length > 0 && !emptyPost) base += '.';
  return base;
}
function sdkSignature(method: 'GET' | 'POST', uri: string, nonce: string, token: string, params: Record<string, string>): string {
  const base = method === 'GET'
    ? constructGetUrl(uri, params)
    : constructGetUrl(uri, {}, Object.keys(params).length === 0)
      + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', token).update(`${base}.${nonce}`).digest('base64');
}

const headersFor = (sig: string, nonce: string) => ({ 'x-plivo-signature-v3': sig, 'x-plivo-signature-v3-nonce': nonce });

describe('Plivo V3 signature', () => {
  it.each(SDK_VECTORS.map((v, i) => [i, v] as const))('vector %i: base and signature match the SDK-checked values', (_i, v) => {
    expect(plivoV3SignedBase(v.method, v.url, v.params)).toBe(v.base);
    expect(computePlivoV3Signature(TOKEN, v.method, v.url, v.params, v.nonce)).toBe(v.sig);
    expect(verifyPlivoV3Signature([TOKEN], { method: v.method, url: v.url, params: v.params, headers: headersFor(v.sig, v.nonce) })).toBe(true);
  });

  it('agrees with the literal SDK port over a grid of URLs and params', () => {
    const urls = [
      'https://h.test/api/v1/webhooks/plivo/webrtc-status/c1',
      'https://h.test/api/v1/webhooks/plivo/webrtc-status/c1/',
      'https://h.test/api/v1/webhooks/plivo/webrtc-status/c1?token=abc&w=3',
      'https://h.test:8443/p?b=2&a=1&a=0',
      'https://h.test/p?x=a%2Bb&y=c+d&z=',
      'https://h.test',
    ];
    const paramSets: Array<Record<string, string>> = [
      {},
      { CallUUID: 'u1', CallStatus: 'completed', Duration: '12', HangupCauseName: 'Normal Hangup' },
      { B: '2', a: '1', A: '3', RecordUrl: 'https://media.plivo.com/v1/Account/MA1/Recording/r.mp3' },
    ];
    for (const url of urls) {
      for (const params of paramSets) {
        for (const method of ['POST', 'GET'] as const) {
          expect(computePlivoV3Signature(TOKEN, method, url, params, 'nonce-1'), `${method} ${url} ${JSON.stringify(params)}`)
            .toBe(sdkSignature(method, url, 'nonce-1', TOKEN, params));
        }
      }
    }
  });

  const v = SDK_VECTORS[0]!;
  const req = (headers: Record<string, string | undefined>, over: Partial<{ url: string; params: Record<string, string> }> = {}) =>
    ({ method: 'POST' as const, url: over.url ?? v.url, params: over.params ?? v.params, headers });

  it('refuses a changed param, URL, query token, nonce or signature', () => {
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(v.sig, v.nonce), { params: { ...v.params, CallStatus: 'completed' } }))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(v.sig, v.nonce), { url: v.url.replace('webrtc-status', 'webrtc-answer') }))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(v.sig, v.nonce), { url: v.url.replace('tok_abc123', 'tok_abc124') }))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(v.sig, `${v.nonce}0`)))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(`A${v.sig.slice(1)}`, v.nonce)))).toBe(false);
  });

  it('refuses another account’s token, and a missing header, nonce or token', () => {
    expect(verifyPlivoV3Signature(['someone-elses-token'], req(headersFor(v.sig, v.nonce)))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req({ 'x-plivo-signature-v3-nonce': v.nonce }))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req({ 'x-plivo-signature-v3': v.sig }))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor('', v.nonce)))).toBe(false);
    expect(verifyPlivoV3Signature([], req(headersFor(v.sig, v.nonce)))).toBe(false);
    expect(verifyPlivoV3Signature([''], req(headersFor(v.sig, v.nonce)))).toBe(false);
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(v.sig, v.nonce), { url: 'not a url' }))).toBe(false);
  });

  it('accepts any signature in the comma-separated list, any token in the list, and headers in any case', () => {
    expect(verifyPlivoV3Signature([TOKEN], req(headersFor(`bogus=, ${v.sig}`, v.nonce)))).toBe(true);
    // The token a rotation retired, still inside the grace window.
    expect(verifyPlivoV3Signature(['new-token-after-rotation', TOKEN], req(headersFor(v.sig, v.nonce)))).toBe(true);
    expect(verifyPlivoV3Signature([TOKEN], req({ 'X-Plivo-Signature-V3': v.sig, 'X-Plivo-Signature-V3-Nonce': v.nonce }))).toBe(true);
  });
});
