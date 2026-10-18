import { describe, it, expect } from 'vitest';
import { padGate, type PadGateInput } from '../../utils/agencyPadGate';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyReservedAttempt, AgencyStationReleasedFrame } from '../../types/agency';
import type { WrapupAnchor } from '../../utils/agencyWrapup';

/**
 * The pad gate, from station state alone: which of the microphone, the pad and
 * the notes are open, and why the three disagree on a lost socket.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
};
const RELEASE: AgencyStationReleasedFrame = {
  event: 'released',
  attempt_id: 'att-1',
  reason: 'completed',
  requires_disposition: true,
  message: 'Call ended.',
};
const ANCHOR: WrapupAnchor = {
  attemptId: 'att-1',
  deadlineMs: null,
  totalMs: null,
  requiresDisposition: true,
  heldReason: 'disposition_required',
  autoReturn: true,
};

const idle: PadGateInput = {
  connection: 'open',
  agentState: 'available',
  live: null,
  retainedAttempt: null,
  release: null,
  wrapup: null,
};
const bridged: PadGateInput = {
  ...idle,
  agentState: 'on_call',
  live: { attempt: ATTEMPT, bridgedAt: '2026-08-11T10:00:04.000Z' },
};

describe('padGate — the pad opens on bridged and stays open through a wrap-up', () => {
  it('is shut while idle and while ringing', () => {
    expect(padGate(idle).padUnlocked).toBe(false);
    expect(padGate({ ...idle, live: { attempt: ATTEMPT, bridgedAt: null } }).padUnlocked).toBe(false);
  });

  it('opens on bridged, and notes track it', () => {
    const gate = padGate(bridged);
    expect(gate.padUnlocked).toBe(true);
    expect(gate.notesEnabled).toBe(true);
  });

  it.each<[string, Partial<PadGateInput>]>([
    ['agent_state says wrapup', { agentState: 'wrapup', retainedAttempt: ATTEMPT }],
    ['the release required a disposition', { agentState: 'on_call', retainedAttempt: ATTEMPT, release: RELEASE }],
    ['a wrap-up anchor requires one (a reconnect mid-wrap-up)', { agentState: 'wrapup', wrapup: ANCHOR }],
  ])('opens for wrap-up when %s — any one route suffices', (_label, overrides) => {
    expect(padGate({ ...idle, ...overrides }).padUnlocked).toBe(true);
  });

  it('does not open for wrap-up without a retained attempt or an anchor', () => {
    // Every frame that ends a wrap-up clears both, so this is the shared OFF switch.
    expect(padGate({ ...idle, agentState: 'wrapup', release: RELEASE }).padUnlocked).toBe(false);
  });
});

describe('padGate — a lost socket: media, pad and notes answer differently', () => {
  it.each<[StationConnection, boolean, boolean]>([
    // connection, stationIsGone (media off), padUnlocked
    ['open', false, true],
    ['reconnecting', false, true],
    ['disconnected', true, true],
    ['superseded', true, false],
    ['session_gone', true, false],
  ])('%s: media gone=%s, pad open=%s', (connection, gone, open) => {
    const gate = padGate({ ...bridged, connection });
    expect(gate.stationIsGone).toBe(gone);
    expect(gate.padUnlocked).toBe(open);
    expect(gate.padHasRival).toBe(connection === 'superseded' || connection === 'session_gone');
    expect(gate.notesEnabled).toBe(open);
  });
});
