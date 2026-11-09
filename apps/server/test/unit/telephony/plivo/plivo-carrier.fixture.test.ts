/**
 * The Plivo carrier fixture (`src/telephony/plivo/plivo-carrier.fixture.json`) pins how
 * Plivo's callbacks are read: for every entry, the normalised shape, the lifecycle event
 * and the terminal classification. It also asserts the fixture covers every terminal
 * status Plivo documents, every classification status and every callback kind, so a new
 * status cannot be handled without an entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PLIVO_SETTINGS, PlivoAdapter, readPlivoCallDetailRecord, type PlivoFetch } from '../../../../src/telephony/plivo/plivo.adapter.js';
import { PLIVO_API_BASE } from '../../../../src/telephony/credentials/credential-specs.js';
import { Secret } from '../../../../src/telephony/credentials/secret.js';
import { plivoInboundUrls, withInboundToken, type PlivoInboundUrls } from '../../../../src/telephony/plivo/inbound-urls.js';
import {
  plivoCreateApplicationBody,
  plivoNumberAppBody,
  plivoUpdateApplicationBody,
  readPlivoApplication,
  readPlivoApplicationPage,
  readPlivoCreatedApplication,
  readPlivoNumberApp,
} from '../../../../src/telephony/plivo/plivo-inbound.wire.js';
import {
  classifyPlivoOutcome,
  normalizePlivoCallback,
  plivoCallEvent,
  PLIVO_TERMINAL_STATUSES,
  type PlivoCallbackKind,
} from '../../../../src/telephony/plivo/plivo.webhook.js';

interface FixtureEntry {
  name: string;
  source: string;
  kind: PlivoCallbackKind;
  params: Record<string, string>;
  normalized: Record<string, unknown>;
  event: {
    eventType: string;
    providerCallId: string;
    /** null = the metadata key is absent. */
    dispositionStatus: string | null;
    /** null = the metadata key is absent. */
    dispositionCause: string | null;
  } | null;
  classification: { status: string; outcome: string; rawCause: string } | null;
}

interface CdrEntry {
  name: string;
  source: string;
  httpStatus: number;
  body: Record<string, unknown>;
  /** What `getCallStatus` answers (`readPlivoCallDetailRecord`). */
  status: string;
}

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/telephony/plivo');
const fixture = JSON.parse(readFileSync(resolve(SRC_DIR, 'plivo-carrier.fixture.json'), 'utf8')) as { entries: FixtureEntry[]; cdr: CdrEntry[] };
const entries = fixture.entries;

const isTerminal = (e: FixtureEntry) => e.kind === 'status' && PLIVO_TERMINAL_STATUSES.has(String(e.normalized['callStatus']));

describe('Plivo carrier fixture', () => {
  it('is well-formed: unique names, a source on every entry', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
    for (const e of entries) expect(e.source.length, e.name).toBeGreaterThan(0);
  });

  it('covers every terminal status Plivo documents, and a status it does not', () => {
    expect([...PLIVO_TERMINAL_STATUSES].sort()).toEqual(['busy', 'cancel', 'completed', 'failed', 'no-answer', 'timeout']);
    const statuses = new Set(entries.map((e) => String(e.normalized['callStatus'])));
    for (const s of PLIVO_TERMINAL_STATUSES) expect(statuses, s).toContain(s);
    expect(statuses).toContain('ringing');
    expect(entries.some((e) => e.kind === 'status' && e.event === null)).toBe(true);
  });

  it('covers every callback kind', () => {
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(['answer', 'status', 'recording']));
  });

  it('covers every classification status, a failed with its raw cause, and an unanswered completed', () => {
    const got = new Set(entries.flatMap((e) => (e.classification ? [`${e.classification.status}/${e.classification.outcome}`] : [])));
    for (const want of ['completed/remote_hangup', 'no_answer/no_answer', 'busy/busy', 'canceled/canceled']) {
      expect(got, want).toContain(want);
    }
    expect(entries.some((e) => e.classification?.status === 'failed' && e.classification.outcome === e.classification.rawCause)).toBe(true);
    expect(entries.some((e) => e.normalized['callStatus'] === 'completed' && e.classification?.status === 'failed')).toBe(true);
  });

  describe.each(entries.map((e) => [e.name, e] as const))('%s', (_name, entry) => {
    it('normalizePlivoCallback produces the recorded shape', () => {
      expect(normalizePlivoCallback(entry.kind, entry.params)).toStrictEqual(entry.normalized);
    });

    it('plivoCallEvent produces the recorded event', () => {
      const ev = plivoCallEvent(normalizePlivoCallback(entry.kind, entry.params), 'call-1');
      if (entry.event === null) {
        expect(ev).toBeNull();
        return;
      }
      expect(ev).not.toBeNull();
      expect(ev!.eventType).toBe(entry.event.eventType);
      expect(ev!.providerCallId).toBe(entry.event.providerCallId);
      expect(ev!.callId).toBe('call-1');
      expect(ev!.provider).toBe('plivo');
      for (const key of ['dispositionStatus', 'dispositionCause'] as const) {
        if (entry.event[key] === null) expect(ev!.metadata).not.toHaveProperty(key);
        else expect(ev!.metadata[key]).toBe(entry.event[key]);
      }
    });

    it('classifyPlivoOutcome produces the recorded classification (terminal only)', () => {
      if (!isTerminal(entry)) {
        expect(entry.classification).toBeNull();
        return;
      }
      expect(entry.classification).not.toBeNull();
      expect(classifyPlivoOutcome(normalizePlivoCallback(entry.kind, entry.params))).toStrictEqual(entry.classification);
      // The event carries the same classification as its disposition.
      expect(entry.event?.dispositionStatus).toBe(entry.classification!.status);
    });
  });
});

describe('Plivo carrier fixture: the call detail record (`GET …/Call/{call_uuid}/`)', () => {
  it('pins the CDR shape (`call_state`, not the live call`s `call_status`), each terminal state and the live 404', () => {
    const cdr = fixture.cdr;
    expect(new Set(cdr.map((e) => e.name)).size).toBe(cdr.length);
    const states = new Set(cdr.map((e) => e.status));
    for (const s of ['busy', 'no-answer', 'cancel', 'failed', 'completed', 'live']) expect(states, s).toContain(s);
    for (const e of cdr.filter((x) => x.httpStatus === 200 && x.status !== 'unknown')) {
      expect(Object.keys(e.body), e.name).toEqual(expect.arrayContaining(['call_uuid', 'call_state', 'hangup_cause_name', 'hangup_cause_code', 'answer_time', 'end_time']));
      expect(e.body, e.name).not.toHaveProperty('call_status');
    }
  });

  it.each(fixture.cdr.map((e) => [e.name, e] as const))('%s', (_name, e) => {
    expect(readPlivoCallDetailRecord(e.httpStatus, JSON.stringify(e.body)).status).toBe(e.status);
  });
});

// ── Inbound: the Application and numbers' apps (docs/inbound.md §8.1; unverified until P0) ──

interface InboundOp {
  source: string;
  verified: boolean;
  method: string;
  path: string;
  request?: Record<string, unknown>;
  response: { status: number; body: unknown };
  read?: unknown;
  appId?: string | null;
}
const inbound = (JSON.parse(readFileSync(resolve(SRC_DIR, 'plivo-carrier.fixture.json'), 'utf8')) as {
  inbound: {
    urls: PlivoInboundUrls; token: string; appName: string;
    createApplication: InboundOp; getApplication: InboundOp; updateApplication: InboundOp; deleteApplication: InboundOp;
    listApplications: InboundOp; getNumber: InboundOp; getNumberWithoutApp: InboundOp; setNumberApp: InboundOp; clearNumberApp: InboundOp;
  };
}).inbound;
const OPS = ['createApplication', 'getApplication', 'updateApplication', 'deleteApplication', 'listApplications',
  'getNumber', 'getNumberWithoutApp', 'setNumberApp', 'clearNumberApp'] as const;

/** An adapter on the fixture's account whose one request is answered with `op`'s response, recording what it sent. */
function fixtureAdapter(op: InboundOp) {
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: PlivoFetch = async (url, init) => {
    sent.push({ url, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return { status: op.response.status, text: async () => (op.response.body === null ? '' : JSON.stringify(op.response.body)) };
  };
  const adapter = new PlivoAdapter({
    ...DEFAULT_PLIVO_SETTINGS, authId: 'MAABCDEFGHIJKLMNOPQR', authToken: new Secret('fixtureAuthToken-0001'), fetchImpl,
  });
  return { adapter, sent };
}

describe('Plivo carrier fixture: inbound Applications and number apps (unverified until P0)', () => {
  it('marks every entry unverified with a source, until the P0 capture replaces it', () => {
    for (const name of OPS) {
      expect(inbound[name].verified, name).toBe(false);
      expect(inbound[name].source, name).toMatch(/UNVERIFIED until the P0 live check/);
    }
  });

  it('the request builders produce the recorded bodies', () => {
    expect(plivoCreateApplicationBody(inbound.appName, inbound.urls, inbound.token)).toStrictEqual(inbound.createApplication.request);
    expect(plivoUpdateApplicationBody(inbound.urls, inbound.token)).toStrictEqual(inbound.updateApplication.request);
    expect(plivoNumberAppBody(inbound.setNumberApp.appId!)).toStrictEqual(inbound.setNumberApp.request);
    expect(plivoNumberAppBody(null)).toStrictEqual(inbound.clearNumberApp.request);
  });

  it('the readers read the recorded responses', () => {
    const text = (op: InboundOp) => JSON.stringify(op.response.body);
    expect(readPlivoCreatedApplication(text(inbound.createApplication))).toBe(inbound.createApplication.read);
    expect(readPlivoApplication(text(inbound.getApplication))).toStrictEqual(inbound.getApplication.read);
    expect(readPlivoApplicationPage(text(inbound.listApplications))).toStrictEqual(inbound.listApplications.read);
    expect(readPlivoNumberApp(text(inbound.getNumber))).toStrictEqual(inbound.getNumber.read);
    expect(readPlivoNumberApp(text(inbound.getNumberWithoutApp))).toStrictEqual(inbound.getNumberWithoutApp.read);
  });

  it('the adapter sends each request to the recorded path and method, and answers what the reader read', async () => {
    const run = async (op: InboundOp, call: (a: PlivoAdapter) => Promise<unknown>) => {
      const { adapter, sent } = fixtureAdapter(op);
      const out = await call(adapter);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(`${PLIVO_API_BASE}${op.path}`);
      expect(sent[0]!.method).toBe(op.method);
      expect(sent[0]!.body).toStrictEqual(op.request);
      return out;
    };
    const app = inbound.createApplication.read as string;
    expect(await run(inbound.createApplication, (a) => a.createInboundApplication(inbound.appName, inbound.urls, inbound.token))).toBe(app);
    expect(await run(inbound.getApplication, (a) => a.getInboundApplication(app))).toStrictEqual(inbound.getApplication.read);
    expect(await run(inbound.updateApplication, (a) => a.updateInboundApplication(app, inbound.urls, inbound.token))).toBe('updated');
    expect(await run(inbound.deleteApplication, (a) => a.deleteInboundApplication(app))).toBe('deleted');
    expect(await run(inbound.listApplications, (a) => a.findInboundApplications(inbound.appName))).toEqual([app]);
    expect(await run(inbound.getNumber, (a) => a.getNumberApp('+14155550101'))).toStrictEqual(inbound.getNumber.read);
    expect(await run(inbound.getNumberWithoutApp, (a) => a.getNumberApp('+14155550102'))).toStrictEqual({ appId: null });
    expect(await run(inbound.setNumberApp, (a) => a.setNumberApp('+14155550101', inbound.setNumberApp.appId!))).toBe('updated');
    expect(await run(inbound.clearNumberApp, (a) => a.setNumberApp('+14155550102', null))).toBe('updated');
  });

  it('the stored URLs are the inbound URL builders` (the answer and hangup given with the token, the fallback without)', () => {
    const cred = /inbound-answer\/([0-9a-f-]{36})$/.exec(inbound.urls.answerUrl)![1]!;
    expect(plivoInboundUrls({ webhookBaseUrl: 'https://agency.example.com/api/v1/webhooks/plivo', inboundFallbackAnswerUrl: '' }, cred))
      .toStrictEqual(inbound.urls);
    expect(inbound.createApplication.request!['answer_url']).toBe(withInboundToken(inbound.urls.answerUrl, inbound.token));
    expect(inbound.createApplication.request!['fallback_answer_url']).toBe(inbound.urls.fallbackAnswerUrl);
  });
});
