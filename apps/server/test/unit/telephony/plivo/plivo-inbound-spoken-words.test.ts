import { describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_STANDARD_WORDS } from '@magick-agency/contracts/api/agency/inbound';
import { PLIVO_INBOUND_SPOKEN_XML } from '../../../../src/telephony/plivo/plivo-inbound.webhook.js';

/**
 * The carrier's spoken stand-ins (`<Speak>`, a call answered before anything streams) say the same
 * sentence as our standard recordings of the closed, call-back and busy messages
 * (docs/inbound.md §3.4): one set of words, whichever way the caller hears them.
 */

const spoken = (xml: string): string => {
  const m = /^<Response><Speak voice="WOMAN" language="en-GB">([^<]+)<\/Speak><Hangup\/><\/Response>$/.exec(xml);
  expect(m, xml).not.toBeNull();
  return m![1]!.replace(/&apos;/g, '’');
};

describe('the spoken messages', () => {
  it('are the standard recordings’ words, with plain apostrophes for the carrier’s speech', () => {
    for (const message of ['closed', 'callback', 'busy'] as const) {
      expect(spoken(PLIVO_INBOUND_SPOKEN_XML[message])).toBe(AGENCY_INBOUND_STANDARD_WORDS[message]);
      expect(PLIVO_INBOUND_SPOKEN_XML[message]).not.toContain('’');
    }
  });

  it('only the call-back message promises a call back', () => {
    expect(spoken(PLIVO_INBOUND_SPOKEN_XML.callback)).toMatch(/we’ll call you back/);
    expect(spoken(PLIVO_INBOUND_SPOKEN_XML.closed)).not.toMatch(/call you back/);
    expect(spoken(PLIVO_INBOUND_SPOKEN_XML.busy)).not.toMatch(/call you back/);
  });
});
