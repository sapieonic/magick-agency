// Which message a caller nobody takes hears, and what prompts their voicemail (docs/inbound.md
// §3.4, §7; `inbound-call-router.ts`): a caller who withheld their number or is on DNC is never
// promised a callback, on every path; a voicemail's prompt is the route's recording for the
// message, else our standard prompt, never one that promises a callback to such a caller.
import { describe, expect, it } from 'vitest';
import {
  mayPromiseCallback,
  messageSlotFor,
  spokenMessageFor,
  voicemailPrompt,
} from '../../../../src/agency/inbound/inbound-call-router.js';
import type { AgencyInboundRouteRecord } from '../../../../src/db/repositories/agency.repository.js';

const CALLER = { from_e164: '+447700900123', caller_dnc: false };
const WITHHELD = { from_e164: null, caller_dnc: false };
const DNC = { from_e164: '+447700900123', caller_dnc: true };
const route = (over: Partial<AgencyInboundRouteRecord> = {}): AgencyInboundRouteRecord => ({
  greeting_audio_id: null, hold_audio_id: null, closed_audio_id: null, busy_audio_id: null,
  recording_notice_audio_id: null, callback_audio_id: null, ...over,
} as AgencyInboundRouteRecord);

describe('mayPromiseCallback', () => {
  it('a caller with a number not on DNC; never a withheld or DNC caller', () => {
    expect(mayPromiseCallback(CALLER)).toBe(true);
    expect(mayPromiseCallback(WITHHELD)).toBe(false);
    expect(mayPromiseCallback(DNC)).toBe(false);
  });
});

describe('messageSlotFor and the carrier’s spoken words', () => {
  it('each plan’s own message', () => {
    expect(messageSlotFor('closed', CALLER)).toBe('closed');
    expect(messageSlotFor('overflow', CALLER)).toBe('callback');
    expect(messageSlotFor('overflow_no_capacity', CALLER)).toBe('busy');
  });

  it('a withheld or DNC caller hears closed instead of the call-back promise; busy promises nothing, so stays', () => {
    for (const caller of [WITHHELD, DNC]) {
      expect(messageSlotFor('overflow', caller)).toBe('closed');
      expect(spokenMessageFor('overflow', caller)).toBe('closed');
      expect(messageSlotFor('overflow_no_capacity', caller)).toBe('busy');
      expect(messageSlotFor('closed', caller)).toBe('closed');
    }
    expect(spokenMessageFor('overflow', CALLER)).toBe('callback');
  });
});

describe('voicemailPrompt', () => {
  it('the route’s recording for the message, falling back to our standard prompt', () => {
    expect(voicemailPrompt(route({ callback_audio_id: 'cb' }), 'callback', CALLER)).toEqual({ slot: 'callback', standard: 'voicemail_prompt' });
    expect(voicemailPrompt(route({ closed_audio_id: 'cl' }), 'closed', CALLER)).toEqual({ slot: 'closed', standard: 'voicemail_prompt' });
  });

  it('no recording for the message: our standard prompt alone', () => {
    expect(voicemailPrompt(route(), 'callback', CALLER)).toEqual({ slot: null, standard: 'voicemail_prompt' });
    expect(voicemailPrompt(route(), 'closed', CALLER)).toEqual({ slot: null, standard: 'voicemail_prompt' });
  });

  it('a withheld or DNC caller: the route’s closed recording only (no standard fallback); with none, no voicemail', () => {
    for (const caller of [WITHHELD, DNC]) {
      expect(voicemailPrompt(route({ closed_audio_id: 'cl' }), 'closed', caller)).toEqual({ slot: 'closed', standard: null });
      expect(voicemailPrompt(route(), 'closed', caller)).toBeNull();
    }
  });
});
