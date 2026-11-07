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

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/telephony/plivo');
const entries = (JSON.parse(readFileSync(resolve(SRC_DIR, 'plivo-carrier.fixture.json'), 'utf8')) as { entries: FixtureEntry[] }).entries;

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
