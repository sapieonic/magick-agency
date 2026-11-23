import { describe, it, expect } from 'vitest';
import { AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS } from '@magick-agency/contracts/api/agency/campaign-templates';
import { TEMPLATE_TAB_SECTIONS, templateTabOf, templateTabs } from '../../utils/agency/campaignTemplates/templateTabs';
import { templateSectionKeys } from '../../utils/agency/campaignTemplates/templateForm';

/**
 * The template editor's tabs (CS21): the campaign setup's steps less Customers, each holding the
 * sections it edits, and only the tabs that hold a section the editor shows.
 */

describe('the template editor’s tabs', () => {
  it('puts every section on exactly one tab, never on Customers', () => {
    const listed = Object.values(TEMPLATE_TAB_SECTIONS).flat();
    expect([...listed].sort()).toEqual([...AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS].sort());
    expect(Object.keys(TEMPLATE_TAB_SECTIONS)).toEqual(['basics', 'purpose', 'agents']);
    for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) expect(TEMPLATE_TAB_SECTIONS[templateTabOf(key)]).toContain(key);
  });

  it('keeps the agent screen whole on Purpose & buttons, with the buttons', () => {
    expect(templateTabOf('agent_screen')).toBe('purpose');
    expect(templateTabOf('outcomes')).toBe('purpose');
    expect(templateTabOf('numbers')).toBe('basics');
    expect(templateTabOf('hours')).toBe('agents');
  });

  it('gives an account template Name & number, Purpose & buttons and Agents & timing, in the steps’ order', () => {
    const tabs = templateTabs(templateSectionKeys('account', { assignment: false, inbound: false }));
    expect(tabs.map((t) => [t.step.id, t.step.title])).toEqual([
      ['basics', 'Name & number'],
      ['purpose', 'Purpose & buttons'],
      ['agents', 'Agents & timing'],
    ]);
    expect(tabs.map((t) => t.sections)).toEqual([
      ['numbers'],
      ['outcomes', 'agent_screen'],
      ['hours', 'retries', 'wrapup', 'recording', 'breaks', 'safety'],
    ]);
  });

  it('leaves Name & number off an organisation template, which holds no numbers (CT15)', () => {
    const tabs = templateTabs(templateSectionKeys('organisation', { assignment: true, inbound: true }));
    expect(tabs.map((t) => t.step.id)).toEqual(['purpose', 'agents']);
    expect(tabs[1]!.sections).toEqual(['hours', 'retries', 'wrapup', 'recording', 'breaks', 'safety', 'assignment', 'inbound']);
  });
});
