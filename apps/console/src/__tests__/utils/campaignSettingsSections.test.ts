import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAMPAIGN_SETTINGS_SECTIONS,
  campaignHasAgentsSection,
  campaignSettingsSectionsFor,
} from '../../utils/campaignSettingsSections';

/**
 * The campaign Settings page's sections. Search deep-links to `…/settings#<id>` by these, so
 * the ids are a contract: pinned here, in page order, each a usable anchor.
 */
describe('CAMPAIGN_SETTINGS_SECTIONS', () => {
  it('names the page’s sections by stable ids, in page order', () => {
    expect(CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'caller-ids',
      'calling-hours',
      'dialling-retries',
      'wrap-up',
      'recording',
      'agents',
      'roster-uploads',
    ]);
  });

  it('has exactly an id, a label and keywords on each, with nothing empty', () => {
    for (const section of CAMPAIGN_SETTINGS_SECTIONS) {
      expect(Object.keys(section).sort()).toEqual(['id', 'keywords', 'label']);
      expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(section.label.trim()).not.toBe('');
      expect(section.keywords.length).toBeGreaterThan(0);
      for (const keyword of section.keywords) {
        expect(keyword).toBe(keyword.trim().toLowerCase());
        expect(keyword).not.toBe('');
      }
      expect(new Set(section.keywords).size).toBe(section.keywords.length);
    }
  });

  it('uses each id and label once', () => {
    const ids = CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.id);
    const labels = CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('spells its labels in British English', () => {
    expect(CAMPAIGN_SETTINGS_SECTIONS.find((s) => s.id === 'dialling-retries')?.label).toBe('Dialling and retries');
  });
});

describe('the sections a campaign’s page has', () => {
  const all = { assignmentEnabled: true, inboundEnabled: true, assignmentLeftovers: false, canSupervise: true };
  const ids = (ctx: typeof all) => campaignSettingsSectionsFor(ctx).map((s) => s.id);

  it('has Agents only with contact assignment, inbound calls or assignment settings left over', () => {
    expect(campaignHasAgentsSection({ assignmentEnabled: false, inboundEnabled: false, assignmentLeftovers: false })).toBe(false);
    expect(campaignHasAgentsSection({ assignmentEnabled: true, inboundEnabled: false, assignmentLeftovers: false })).toBe(true);
    expect(campaignHasAgentsSection({ assignmentEnabled: false, inboundEnabled: true, assignmentLeftovers: false })).toBe(true);
    expect(campaignHasAgentsSection({ assignmentEnabled: false, inboundEnabled: false, assignmentLeftovers: true })).toBe(true);
    expect(ids({ ...all, assignmentEnabled: false, inboundEnabled: false })).not.toContain('agents');
  });

  it('has Lifecycle and uploads only at agency.supervise, and everything else always, in page order', () => {
    expect(ids(all)).toEqual(CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.id));
    expect(ids({ ...all, canSupervise: false })).not.toContain('roster-uploads');
  });

  it('is what the Settings page reads to show Agents', () => {
    const page = readFileSync(resolve(__dirname, '../../pages/agency/AgencyCampaignSettingsPage.tsx'), 'utf-8');
    expect(page).toMatch(/const agentsVisible = campaignHasAgentsSection\(/);
  });
});
