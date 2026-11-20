import { describe, it, expect } from 'vitest';
import {
  AGENT_HOME_COPY,
  callLaterLine,
  homeBand,
  workStatus,
  workTile,
} from '../../utils/agency/agentHome';

/**
 * The agent's work picker (spec §3 01, AS1, AS15): what each list's tile says, whether it can be
 * opened, and the band for each of the page's screens.
 */

const BANNED = /disposition|wrap-?up|pacing|session|station|\bSIP\b|webrtc|\bDNC\b|call-?back|campaign|reserved|\bavailable\b|\boffline\b|reconnecting/i;

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [(value as (a: unknown) => string)('Renewals'), (value as (a: unknown) => string)(3), (value as (a: unknown) => string)(null)];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const STATUSES = ['running', 'paused', 'draft', 'stopping', 'stopped', 'completed', null, 'draining'];

describe('workStatus', () => {
  it.each([
    ['running', 'ready', 'Calling is on'],
    ['paused', 'quiet', 'Paused by your supervisor'],
    ['draft', 'quiet', 'Not started yet'],
    ['stopping', 'quiet', 'No calls right now'],
    ['stopped', 'quiet', 'Ended by your supervisor. No more calls.'],
    ['completed', 'quiet', 'Finished. Every customer was called.'],
  ])('says what %s means in plain words', (status, tone, line) => {
    expect(workStatus(status)).toMatchObject({ tone, line });
  });

  it.each([null, undefined, '', 'draining', 'toString'])('says nothing it cannot stand behind for %p', (status) => {
    expect(workStatus(status)).toBeNull();
  });
});

describe('workTile', () => {
  const a = (over: Record<string, unknown>) => ({ campaign_id: 'c-1', campaign_name: 'Renewals', campaign_status: 'running', assigned_at: 'x', ...over });

  it('opens every list but a stopped or completed one', () => {
    for (const status of STATUSES) {
      expect(workTile(a({ campaign_status: status })).canOpen, String(status)).toBe(status !== 'stopped' && status !== 'completed');
    }
  });

  it('names a list with no name, never a hole', () => {
    expect(workTile(a({ campaign_name: null })).name).toBe('Unnamed list');
    expect(workTile(a({ campaign_name: '   ' })).name).toBe('Unnamed list');
    expect(workTile(a({})).name).toBe('Renewals');
  });
});

describe('callLaterLine', () => {
  it('counts today and late, and is hidden when there are none', () => {
    expect(callLaterLine({ today: 3, overdue: 0 })).toBe('Call later · 3 today');
    expect(callLaterLine({ today: 0, overdue: 2 })).toBe('Call later · 2 late');
    expect(callLaterLine({ today: 1, overdue: 1 })).toBe('Call later · 1 today · 1 late');
    expect(callLaterLine({ today: 0, overdue: 0 })).toBeNull();
    expect(callLaterLine(null)).toBeNull();
  });
});

describe('homeBand', () => {
  it('greets the agent and asks them to choose, or names the one list', () => {
    expect(homeBand({ kind: 'list', arrival: null, count: 2 }, 'Sunita')).toMatchObject({ tone: 'start', icon: 'headphones', title: 'Namaste, Sunita', subtitle: 'Choose your work for today.' });
    expect(homeBand({ kind: 'list', arrival: null, count: 1 }, null)).toMatchObject({ title: 'Namaste', subtitle: 'Here is your work for today.' });
  });

  it('never tells a refused agent that they finished', () => {
    const finished = homeBand({ kind: 'list', arrival: 'station', count: 1 }, null);
    const refused = homeBand({ kind: 'list', arrival: 'refused', count: 1 }, null);
    expect(finished).toMatchObject({ tone: 'start', icon: 'log_out', title: 'Work finished for now' });
    expect(refused).toMatchObject({ tone: 'problem', icon: 'warning', title: 'Your work did not open' });
    expect(refused.subtitle).not.toMatch(/finish/i);
  });

  it('has a band for loading, none yet and a failed read', () => {
    expect(homeBand({ kind: 'none' }, null)).toMatchObject({ tone: 'quiet', title: 'No work for you yet' });
    expect(homeBand({ kind: 'error' }, null)).toMatchObject({ tone: 'problem', title: 'We could not load your work' });
    expect(homeBand({ kind: 'loading' }, 'Sunita').title).toBe('Namaste, Sunita');
  });
});

describe('the picker’s words (AS15, spec §6.6)', () => {
  const all = [
    ...strings(AGENT_HOME_COPY),
    ...STATUSES.map((s) => workStatus(s)?.line ?? ''),
    ...(['loading', 'error', 'none'] as const).flatMap((kind) => Object.values(homeBand({ kind }, 'Sunita'))),
    ...([null, 'station', 'refused'] as const).flatMap((arrival) => [1, 2].flatMap((count) => Object.values(homeBand({ kind: 'list', arrival, count }, null)))),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  it('collects a real body of words', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it('never says the jargon', () => {
    // `screen` ids (home_choose, ...) are not words on screen; the agent-facing ones are checked.
    expect(all.filter((line) => !line.startsWith('home_') && BANNED.test(line))).toEqual([]);
  });

  it('spells the British way', () => {
    expect(all.filter((line) => /\b(canceled|color|dialed|organization|center)\b/i.test(line))).toEqual([]);
  });
});
