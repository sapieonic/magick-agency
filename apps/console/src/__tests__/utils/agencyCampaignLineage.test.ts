import { describe, it, expect } from 'vitest';
import { lineagePositionLabel, lineageStripModel } from '../../utils/agencyCampaignLineage';
import type { AgencyCampaignLineage, AgencyCampaignLineageEntry } from '../../types/agency-campaign';

function entry(over: Partial<AgencyCampaignLineageEntry> = {}): AgencyCampaignLineageEntry {
  return {
    id: 'camp-root',
    name: 'Q3 Winback',
    status: 'completed',
    retry_generation: 0,
    parent_campaign_id: null,
    contacts_total: 4000,
    created_at: '2026-07-01T09:00:00.000Z',
    started_at: '2026-07-01T10:00:00.000Z',
    ended_at: '2026-07-20T18:00:00.000Z',
    ...over,
  };
}

const CHILD = entry({
  id: 'camp-r1',
  name: 'Q3 Winback — Retry 1',
  status: 'draft',
  retry_generation: 1,
  parent_campaign_id: 'camp-root',
  contacts_total: 812,
  started_at: null,
  ended_at: null,
});

function lineage(campaigns: AgencyCampaignLineageEntry[]): AgencyCampaignLineage {
  return { root_campaign_id: 'camp-root', campaigns };
}

describe('a campaign that is part of no chain', () => {
  it('renders nothing for the documented single-entry answer', () => {
    // The route answers with the campaign itself rather than a 404, so this is
    // the 100% case today and it must produce no strip at all — not an empty
    // one, and certainly not a campaign announced as its own ancestor.
    expect(lineageStripModel(lineage([entry()]), 'camp-root')).toBeNull();
  });

  it('renders nothing while the read is still in flight', () => {
    expect(lineageStripModel(null, 'camp-root')).toBeNull();
  });

  it('renders nothing for a chain that does not contain this campaign', () => {
    // Only reachable as an answer for a different campaign arriving late.
    expect(lineageStripModel(lineage([entry(), CHILD]), 'camp-elsewhere')).toBeNull();
  });
});

describe('on a child', () => {
  it('names the generation and the ROOT, not the immediate parent', () => {
    const model = lineageStripModel(lineage([entry(), CHILD]), 'camp-r1');
    expect(model?.headline).toBe('Retry 1 of Q3 Winback');
  });

  it('still names the root three generations down', () => {
    // "Retry 2 of Q3 Winback — Retry 1" is a sentence nobody can parse, and the
    // root is the name everyone knows the work by.
    const second = entry({
      id: 'camp-r2',
      name: 'Q3 Winback — Retry 2',
      retry_generation: 2,
      parent_campaign_id: 'camp-r1',
    });
    const model = lineageStripModel(lineage([entry(), CHILD, second]), 'camp-r2');
    expect(model?.headline).toBe('Retry 2 of Q3 Winback');
  });
});

describe('on a parent', () => {
  it('counts the retries BELOW it, never the length of the chain', () => {
    // A parent is not one of its own retries.
    const second = entry({ id: 'camp-r2', retry_generation: 2, parent_campaign_id: 'camp-r1' });
    const model = lineageStripModel(lineage([entry(), CHILD, second]), 'camp-root');
    expect(model?.headline).toBe('Retried 2 times');
  });

  it('says "1 time" for one retry', () => {
    const model = lineageStripModel(lineage([entry(), CHILD]), 'camp-root');
    expect(model?.headline).toBe('Retried 1 time');
  });
});

describe('the links', () => {
  it('labels each entry by its position and marks the one being read', () => {
    const model = lineageStripModel(lineage([entry(), CHILD]), 'camp-r1');
    expect(model?.entries.map((e) => e.position)).toEqual(['Original', 'Retry 1']);
    expect(model?.entries.map((e) => e.isCurrent)).toEqual([false, true]);
  });

  it('carries the name and the roster size, which the position alone does not say', () => {
    const model = lineageStripModel(lineage([entry(), CHILD]), 'camp-r1');
    expect(model?.entries[0]).toMatchObject({ name: 'Q3 Winback', contactsTotal: 4000 });
    expect(model?.entries[1]).toMatchObject({ name: 'Q3 Winback — Retry 1', contactsTotal: 812 });
  });
});

describe('position labels', () => {
  it('calls generation 0 the original', () => {
    expect(lineagePositionLabel(0)).toBe('Original');
  });

  it('numbers every generation above it', () => {
    expect(lineagePositionLabel(1)).toBe('Retry 1');
    expect(lineagePositionLabel(7)).toBe('Retry 7');
  });
});
