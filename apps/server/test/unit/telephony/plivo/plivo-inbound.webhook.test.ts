// The inbound callback reader (`plivo-inbound.webhook.ts`) against its fixture
// (`plivo-inbound.fixture.json`, every entry unverified until P0), the bridge event a hangup
// becomes, and the fixed XML Plivo speaks where nothing streams.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLIVO_INBOUND_CLOSED_XML,
  PLIVO_INBOUND_FALLBACK_XML,
  plivoInboundHangupEvent,
  readPlivoInboundArrival,
  readPlivoInboundHangup,
} from '../../../../src/telephony/plivo/plivo-inbound.webhook.js';
import { plivoLifecycle } from '../../../../src/telephony/plivo/plivo.media.js';

interface Entry {
  name: string;
  verified: boolean;
  kind: 'answer' | 'hangup';
  params: Record<string, string>;
  arrival?: Record<string, unknown>;
  hangup?: Record<string, unknown>;
}

const fixture = JSON.parse(readFileSync(new URL('../../../../src/telephony/plivo/plivo-inbound.fixture.json', import.meta.url), 'utf8')) as {
  entries: Entry[];
};

describe('the inbound fixture', () => {
  it('marks every entry unverified until a live inbound call is captured (P0)', () => {
    expect(fixture.entries.length).toBeGreaterThan(0);
    expect(fixture.entries.filter((e) => e.verified !== false).map((e) => e.name)).toEqual([]);
  });

  for (const entry of fixture.entries.filter((e) => e.kind === 'answer')) {
    it(`answer — ${entry.name}`, () => {
      const read = readPlivoInboundArrival(entry.params);
      const { ok, ...rest } = entry.arrival as { ok: boolean };
      expect(read.ok).toBe(ok);
      expect(read.ok ? read.arrival : { reason: read.reason }).toEqual(rest);
    });
  }

  for (const entry of fixture.entries.filter((e) => e.kind === 'hangup')) {
    it(`hangup — ${entry.name}`, () => {
      expect(readPlivoInboundHangup(entry.params)).toEqual(entry.hangup);
    });
  }
});

describe('plivoInboundHangupEvent', () => {
  it('is a hangup of an answered inbound leg, read back by the Plivo lifecycle as a completed call', () => {
    const h = readPlivoInboundHangup({ CallUUID: 'cu-1', CallStatus: 'completed', HangupSource: 'Caller', HangupCauseName: 'Normal Hangup', Duration: '9' });
    const event = plivoInboundHangupEvent(h, 'leg-1');
    expect(event).toMatchObject({ callId: 'leg-1', providerCallId: 'cu-1', provider: 'plivo', eventType: 'hangup', direction: 'inbound' });
    const facts = plivoLifecycle.readEvent(event);
    expect(facts.carrierCallId).toBe('cu-1');
    expect(facts.wasAnswered).toBe(true);
    expect(facts.classify(true).status).toBe('completed');
  });

  it('settles as completed whatever terminal status the carrier names, since our answer answered it', () => {
    const facts = plivoLifecycle.readEvent(plivoInboundHangupEvent(readPlivoInboundHangup({ CallUUID: 'cu-2', CallStatus: 'failed' }), 'leg-2'));
    expect(facts.classify(facts.wasAnswered).status).toBe('completed');
  });
});

describe('the fixed XML', () => {
  it('the fallback apologises in British English, promises no callback (it may leave no Missed row) and hangs up', () => {
    expect(PLIVO_INBOUND_FALLBACK_XML).toBe(
      '<Response><Speak voice="WOMAN" language="en-GB">Sorry, we can&apos;t take your call right now. Please try again shortly.</Speak><Hangup/></Response>');
  });

  it('the closed message hangs up and never streams', () => {
    expect(PLIVO_INBOUND_CLOSED_XML).toMatch(/^<Response><Speak voice="WOMAN" language="en-GB">[^<]+<\/Speak><Hangup\/><\/Response>$/);
    expect(PLIVO_INBOUND_CLOSED_XML).not.toContain('<Stream');
  });
});
