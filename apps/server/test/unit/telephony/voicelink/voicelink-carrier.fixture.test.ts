/**
 * The VoiceLink carrier fixture (`src/telephony/voicelink/voicelink-carrier.fixture.json`)
 * pins VoiceLink webhook behaviour. Every entry's body is a recorded carrier
 * payload (its `source` field names where it came from), and
 * this file asserts the normaliser still produces the recorded
 * normalised shape, CallEvent and terminal classification for each.
 *
 * It also asserts the fixture covers every `case` of the `parseVoicelinkWebhook`
 * switch (and its `default`), so a new carrier event cannot be added to the
 * parser without a fixture entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeVoicelinkWebhook,
  parseVoicelinkWebhook,
  classifyVoicelinkOutcome,
} from '../../../../src/telephony/voicelink/voicelink.webhook.js';
import type { VoicelinkWebhookBody } from '../../../../src/telephony/voicelink/voicelink.types.js';

interface FixtureEntry {
  name: string;
  source: string;
  callId: string;
  body: Record<string, unknown>;
  parsed: {
    eventType: string;
    providerCallId: string;
    callId: string;
    direction: 'inbound' | 'outbound';
    /** null = the metadata key is absent. */
    dispositionStatus: string | null;
    /** null = the metadata key is absent. */
    dispositionCause: string | null;
  } | null;
  normalized: Record<string, unknown>;
  classification: { status: string; outcome: string; rawCause: string } | null;
}

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/telephony/voicelink');
const fixture = JSON.parse(
  readFileSync(resolve(SRC_DIR, 'voicelink-carrier.fixture.json'), 'utf8'),
) as { entries: FixtureEntry[] };
const entries = fixture.entries;

const TERMINAL_EVENTS = new Set(['call.ended', 'call.failed', 'call.completed']);

/** The `case '<event>':` labels of `parseVoicelinkWebhook`'s switch, read from source. */
function parserSwitchCases(): string[] {
  const src = readFileSync(resolve(SRC_DIR, 'voicelink.webhook.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function parseVoicelinkWebhook('));
  const switchBody = fn.slice(fn.indexOf('switch (n.event)'), fn.indexOf('default:'));
  return [...switchBody.matchAll(/case '([^']+)':/g)].map((m) => m[1]!);
}

describe('VoiceLink carrier fixture', () => {
  it('is well-formed: unique names, a source on every entry', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.source, e.name).toMatch(/^test\/unit\/telephony\/voicelink\/.+\.test\.ts > /);
    }
  });

  it('covers every case of the parseVoicelinkWebhook switch, and its default', () => {
    const cases = parserSwitchCases();
    // Sanity: the extraction found the switch, not an empty slice.
    expect(cases.sort()).toEqual(
      ['call.answered', 'call.completed', 'call.ended', 'call.failed', 'call.initiated', 'call.ringing'],
    );
    const events = new Set(entries.map((e) => String(e.normalized['event'])));
    for (const c of cases) expect(events, `no fixture entry for ${c}`).toContain(c);
    // The default arm: at least one event the switch does not name.
    expect(entries.some((e) => !cases.includes(String(e.normalized['event'])))).toBe(true);
  });

  it('covers both payload shapes (nested call.* and flat top-level)', () => {
    expect(entries.some((e) => typeof e.body['call'] === 'object')).toBe(true);
    expect(entries.some((e) => e.body['call'] === undefined && Object.keys(e.body).length > 1)).toBe(true);
  });

  it('covers every classification status, and both busy outcomes', () => {
    const got = new Set(entries.flatMap((e) => (e.classification ? [`${e.classification.status}/${e.classification.outcome}`] : [])));
    for (const want of ['completed/remote_hangup', 'no_answer/no_answer', 'busy/busy', 'busy/not_reached', 'canceled/canceled', 'failed/telephony_error']) {
      expect(got, want).toContain(want);
    }
    expect(entries.some((e) => e.classification?.status === 'failed' && e.classification.outcome !== 'telephony_error')).toBe(true);
  });

  describe.each(entries.map((e) => [e.name, e] as const))('%s', (_name, entry) => {
    const body = entry.body as VoicelinkWebhookBody;

    it('normalizeVoicelinkWebhook produces the recorded shape', () => {
      expect(normalizeVoicelinkWebhook(body)).toStrictEqual(entry.normalized);
    });

    it('parseVoicelinkWebhook produces the recorded event', () => {
      const ev = parseVoicelinkWebhook(body, entry.callId);
      if (entry.parsed === null) {
        expect(ev).toBeNull();
        return;
      }
      expect(ev).not.toBeNull();
      expect(ev!.eventType).toBe(entry.parsed.eventType);
      expect(ev!.providerCallId).toBe(entry.parsed.providerCallId);
      expect(ev!.callId).toBe(entry.parsed.callId);
      expect(ev!.direction).toBe(entry.parsed.direction);
      for (const key of ['dispositionStatus', 'dispositionCause'] as const) {
        if (entry.parsed[key] === null) expect(ev!.metadata).not.toHaveProperty(key);
        else expect(ev!.metadata[key]).toBe(entry.parsed[key]);
      }
    });

    it('classifyVoicelinkOutcome produces the recorded classification (terminal only)', () => {
      const n = normalizeVoicelinkWebhook(body);
      if (!TERMINAL_EVENTS.has(n.event)) {
        expect(entry.classification).toBeNull();
        return;
      }
      expect(entry.classification).not.toBeNull();
      expect(classifyVoicelinkOutcome(n)).toStrictEqual(entry.classification);
      // The parser attaches the same classification as the event's disposition.
      expect(entry.parsed?.dispositionStatus).toBe(entry.classification!.status);
    });
  });
});
