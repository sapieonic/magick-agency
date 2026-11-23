import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAMPAIGN_SETTINGS_SECTIONS,
  campaignSettingsSectionsFor,
  sectionIdOfHash,
  settingsTabOfChange,
  settingsTabOfField,
} from '../../utils/campaignSettingsSections';
import { SETUP_STEP_IDS, isSetupStepId } from '../../utils/campaignSetup/setupSteps';

/**
 * The campaign Settings page's sections. Search deep-links to `…/settings#<id>` by these, so
 * the ids are a contract: pinned here, in page order, each a usable anchor, each on the tab (the
 * setup step, CS1) that holds it (CS16).
 */
describe('CAMPAIGN_SETTINGS_SECTIONS', () => {
  it('names the page’s sections by stable ids, in page order', () => {
    expect(CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'general',
      'caller-ids',
      'agent-screen',
      'roster-uploads',
      'wrap-up',
      'script',
      'calling-hours',
      'recording',
      'dialling-retries',
      'agents',
    ]);
  });

  it('puts each section on its tab, the tabs in step order', () => {
    expect(CAMPAIGN_SETTINGS_SECTIONS.map((s) => [s.id, s.tab, s.advanced === true])).toEqual([
      ['general', 'basics', false],
      ['caller-ids', 'basics', false],
      ['agent-screen', 'contacts', false],
      ['roster-uploads', 'contacts', false],
      ['wrap-up', 'purpose', false],
      ['script', 'purpose', false],
      ['calling-hours', 'agents', false],
      ['recording', 'agents', false],
      ['dialling-retries', 'agents', true],
      ['agents', 'agents', true],
    ]);
    const order = CAMPAIGN_SETTINGS_SECTIONS.map((s) => SETUP_STEP_IDS.indexOf(s.tab));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Every tab has a section a link can land on.
    expect(new Set(CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.tab))).toEqual(new Set(SETUP_STEP_IDS));
  });

  it.each([
    // A setting split off an old section is found where it is now.
    ['daily target', 'agents'],
    ['full number', 'agents'],
    ['wrap-up', 'agents'],
    ['auto return', 'agents'],
    ['customer card', 'contacts'],
    ['outcomes', 'purpose'],
    ['script', 'purpose'],
    ['caller id', 'basics'],
    ['abandonment', 'agents'],
    ['break limit', 'agents'],
  ])('finds “%s” only on the %s tab', (word, tab) => {
    const holding = CAMPAIGN_SETTINGS_SECTIONS.filter((s) => s.keywords.includes(word));
    expect(holding.length).toBeGreaterThan(0);
    expect(holding.map((s) => s.tab)).toEqual(holding.map(() => tab));
  });

  it('has an id, a label, its tab and keywords on each, with nothing empty', () => {
    for (const section of CAMPAIGN_SETTINGS_SECTIONS) {
      expect(Object.keys(section).filter((key) => key !== 'advanced').sort()).toEqual(['id', 'keywords', 'label', 'tab']);
      expect(isSetupStepId(section.tab)).toBe(true);
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
  const all = { canSupervise: true };
  const ids = (ctx: typeof all) => campaignSettingsSectionsFor(ctx).map((s) => s.id);

  it('has Agents on every campaign: break limits are every campaign’s (LF27)', () => {
    expect(ids(all)).toContain('agents');
    expect(ids({ canSupervise: false })).toContain('agents');
    expect(CAMPAIGN_SETTINGS_SECTIONS.find((s) => s.id === 'agents')?.keywords).toEqual(
      expect.arrayContaining(['break limit', 'tea', 'lunch']),
    );
  });

  it('has Lifecycle and uploads only at agency.supervise, and everything else always, in page order', () => {
    expect(ids(all)).toEqual(CAMPAIGN_SETTINGS_SECTIONS.map((s) => s.id));
    expect(ids({ ...all, canSupervise: false })).not.toContain('roster-uploads');
  });

  it('is what the Settings page reads to show its sections and land links on them', () => {
    const page = readFileSync(resolve(__dirname, '../../pages/agency/AgencyCampaignSettingsPage.tsx'), 'utf-8');
    expect(page).toMatch(/const sections = useMemo\(\(\) => campaignSettingsSectionsFor\(/);
    expect(page).toMatch(/const historyVisible = sections\.some\(/);
  });
});

describe('which tab a finding or a change is on', () => {
  it.each([
    ['name', 'basics'],
    ['caller_ids', 'basics'],
    ['telephony_credential_id', 'basics'],
    ['context_display.facts.0.label', 'contacts'],
    ['context_display.roles.place', 'contacts'],
    ['disposition_catalog[2].code', 'purpose'],
    ['outcome_dispositions.no_answer', 'purpose'],
    ['agent_script.steps[1].text', 'purpose'],
    ['calling_window_end', 'agents'],
    ['retry_policy.busy.max_attempts', 'agents'],
    ['abandonment_ceiling_pct', 'agents'],
    ['record_calls', 'agents'],
    ['analysis_profile_id', 'agents'],
    ['assignment_mode', 'agents'],
    ['break_reasons[1].icon', 'agents'],
    ['daily_target_calls', 'agents'],
    ['phone_display', 'agents'],
  ])('a finding on %s is on %s', (field, tab) => {
    expect(settingsTabOfField(field)).toBe(tab);
  });

  it.each([
    ['name', 'basics'],
    ['carrier', 'basics'],
    ['callerIds', 'basics'],
    ['customerFacts', 'contacts'],
    ['dispositions', 'purpose'],
    ['outcomeDispositions', 'purpose'],
    ['script', 'purpose'],
    ['window.start', 'agents'],
    ['retryPolicy', 'agents'],
    ['wrapupSeconds', 'agents'],
    ['recording.record', 'agents'],
    ['breakReasons', 'agents'],
    ['dailyTarget', 'agents'],
    ['phoneDisplay', 'agents'],
    ['staffing', 'agents'],
  ])('a change to %s is on %s', (change, tab) => {
    expect(settingsTabOfChange(change)).toBe(tab);
  });
});

describe('sectionIdOfHash', () => {
  it('reads the id a hash names, decoded, and a malformed one as written', () => {
    expect(sectionIdOfHash('#calling-hours')).toBe('calling-hours');
    expect(sectionIdOfHash('')).toBe('');
    expect(sectionIdOfHash('#caller%2Dids')).toBe('caller-ids');
    expect(sectionIdOfHash('#%E0%A4%A')).toBe('%E0%A4%A');
  });
});
