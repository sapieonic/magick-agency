import type { AgencyCampaignTemplateSectionKey } from '@magick-agency/contracts/api/agency/campaign-templates';
import { SETUP_STEPS, type SetupStep, type SetupStepId } from '../../campaignSetup/setupSteps';

/**
 * The template editor's tabs (CS21, `docs/campaign-templates.md` §7): the campaign setup's steps
 * (`SETUP_STEPS`, CS1), less Customers, since a template holds no roster or card (§3).
 */
export type TemplateTabId = Exclude<SetupStepId, 'contacts'>;

/**
 * Which tab each section is edited on, in the order the tab shows them. A section is one Use/Set
 * choice, so it sits whole on one tab. Numbers on Name & number, as on step 1. The agent screen
 * (the script, how the number is shown and the daily target) on Purpose & buttons with the
 * buttons: its script is most of it, and both campaign pages show the script there (CS19).
 * Everything else on Agents & timing, in the order the step shows it: its main blocks, then what
 * it keeps under Advanced.
 */
export const TEMPLATE_TAB_SECTIONS: Readonly<Record<TemplateTabId, readonly AgencyCampaignTemplateSectionKey[]>> = {
  basics: ['numbers'],
  purpose: ['outcomes', 'agent_screen'],
  agents: ['hours', 'retries', 'wrapup', 'recording', 'breaks', 'safety', 'assignment', 'inbound'],
};

/** The tab that edits section `key`. */
export function templateTabOf(key: AgencyCampaignTemplateSectionKey): TemplateTabId {
  for (const [tab, keys] of Object.entries(TEMPLATE_TAB_SECTIONS) as [TemplateTabId, readonly AgencyCampaignTemplateSectionKey[]][]) {
    if (keys.includes(key)) return tab;
  }
  // Unreachable while every section is listed above (templateTabs.test.ts).
  return 'agents';
}

export interface TemplateTab {
  step: SetupStep & { id: TemplateTabId };
  /** The shown sections it holds, in its order. */
  sections: AgencyCampaignTemplateSectionKey[];
}

/**
 * The tabs a template showing `visible` sections has: the setup steps in their order, each with
 * the shown sections it holds, and only those holding one (an organisation template has no
 * numbers, so no Name & number, CT15).
 */
export function templateTabs(visible: readonly AgencyCampaignTemplateSectionKey[]): TemplateTab[] {
  const tabs: TemplateTab[] = [];
  for (const step of SETUP_STEPS) {
    if (step.id === 'contacts') continue;
    const id = step.id;
    const sections = TEMPLATE_TAB_SECTIONS[id].filter((key) => visible.includes(key));
    if (sections.length > 0) tabs.push({ step: { ...step, id }, sections });
  }
  return tabs;
}
