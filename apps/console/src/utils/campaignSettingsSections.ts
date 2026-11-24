import type { SetupStepId } from './campaignSetup/setupSteps';

/**
 * The sections of a campaign's Settings page (`/agency/campaigns/:id/settings`), in page order.
 * The page is the four setup steps shown as tabs (CS1); each section lives in one of them
 * (`tab`). Each `id` is an element on the page, so `…/settings#calling-hours` opens the Agents &
 * timing tab and scrolls to it (CS16), and search deep-links to them by their keywords. A section
 * under a step's folded Advanced settings is `advanced`: a link to it opens the fold.
 *
 * The ids came from the page's old one-column layout. Where an old section's settings were split
 * across tabs, the id stayed with its main setting and its keywords moved with the rest: the daily
 * target and the number display are on Agents & timing (`recording`, beside recording and the
 * wrap-up time), the customer card on Customers (`agent-screen`), and the outcomes on Purpose &
 * buttons (`wrap-up`). Keywords name only what the section's tab really has.
 *
 * A section shows only when it has something on the page. Every campaign has Agents: its break
 * limits are every campaign's (LF27), beside contact assignment and inbound calls when those are
 * on. Lifecycle and uploads needs `agency.supervise`, the floor of its reads. The ids are stable;
 * rename a label freely, never an id, since links carry them.
 */
export interface CampaignSettingsSectionDef {
  id: string;
  label: string;
  keywords: string[];
  /** The Settings tab (setup step) the section is on. */
  tab: SetupStepId;
  /** Inside the step's folded "Advanced settings": a link to it opens the fold. */
  advanced?: true;
}

export const CAMPAIGN_SETTINGS_SECTIONS: CampaignSettingsSectionDef[] = [
  {
    id: 'general',
    label: 'Campaign name',
    tab: 'basics',
    keywords: ['name', 'rename', 'campaign name', 'title'],
  },
  {
    id: 'caller-ids',
    label: 'Caller IDs',
    tab: 'basics',
    keywords: ['caller id', 'caller ids', 'number', 'numbers', 'cli', 'dial from', 'carrier', 'carrier account', 'telephony'],
  },
  {
    // AS19: the name, the line under it, up to 4 facts with their names, keys and highlight, and
    // how each column is read. Its old daily target and number display are on Agents & timing.
    id: 'agent-screen',
    label: 'What agents see on the customer card',
    tab: 'contacts',
    keywords: [
      'customer card', 'customer facts', 'facts', 'fact name', 'highlight', 'key', 'customer name',
      'line under the name', 'place', 'column', 'money', 'date', 'number', 'yes / no', 'full and half',
    ],
  },
  {
    // The page shows the campaign's lifecycle and its roster upload history here.
    id: 'roster-uploads',
    label: 'Lifecycle and uploads',
    tab: 'contacts',
    keywords: ['uploads', 'upload history', 'roster', 'contact list', 'csv', 'file', 'lifecycle', 'started', 'paused', 'stopped'],
  },
  {
    // CS2–CS4: the starting point, the buttons as sentences, the agent's view of them, and under
    // Advanced the full outcome editor and the automatic outcomes for unanswered calls.
    id: 'wrap-up',
    label: 'Purpose and outcome buttons',
    tab: 'purpose',
    keywords: [
      'outcomes', 'dispositions', 'disposition codes', 'buttons', 'number keys', 'purpose', 'starting point',
      'unanswered calls', 'voicemail', 'icon', 'picture', 'outcome picture',
    ],
  },
  {
    // Agent station (BE-8, AS19): the opening line and the steps agents read out, with the card's keys.
    id: 'script',
    label: 'Script',
    tab: 'purpose',
    keywords: ['script', 'opening line', 'what to say', 'steps', 'pitch', 'placeholder', 'keys'],
  },
  {
    id: 'calling-hours',
    label: 'Calling hours',
    tab: 'agents',
    keywords: ['hours', 'calling window', 'window', 'time zone', 'timezone', 'days', 'weekdays', 'schedule', 'start time', 'end time'],
  },
  {
    // The agent screen's switches (CS14): wrap-up time, recording, the call summary, the number
    // display (AS9) and the daily target (AS6). Wrap-up's auto return is under Advanced.
    id: 'recording',
    label: 'Agent screen and recording',
    tab: 'agents',
    keywords: [
      'record', 'recording', 'call recording', 'call summary', 'summary', 'summary profile', 'analysis profile', 'transcript',
      'wrap-up', 'wrapup', 'after-call work', 'auto return', 'daily target', 'target', 'calls a day', 'goal', 'phone number',
      'full number', 'hidden number', 'mask', 'masked', 'hide number',
    ],
  },
  {
    // CS12–CS13: the full retry table and the abandonment limit, with its grace (AG2).
    id: 'dialling-retries',
    label: 'Dialling and retries',
    tab: 'agents',
    advanced: true,
    keywords: ['retry', 'retries', 'redial', 'attempts', 'busy', 'no answer', 'gap between tries', 'abandonment', 'abandon rate', 'ceiling', 'auto pause', 'pacing', 'abandonment grace', 'audio connects'],
  },
  {
    // CS13: contact assignment and inbound callers (each behind its flag) and the break limits.
    id: 'agents',
    label: 'Agents',
    tab: 'agents',
    advanced: true,
    keywords: ['contact assignment', 'assignment mode', 'assign contacts', 'owner', 'own contacts', 'agent retry', 'sticky agent', 'inbound', 'put callers through', 'break', 'breaks', 'break limit', 'break reasons', 'tea', 'lunch', 'break picture'],
  },
];

/** What decides which sections a campaign's Settings page has, for this reader. */
export interface CampaignSettingsSectionContext {
  /** The reader holds `agency.supervise`, the floor of Lifecycle and uploads' reads. */
  canSupervise: boolean;
}

/** The sections a campaign's Settings page has for this reader, in page order. */
export function campaignSettingsSectionsFor(ctx: CampaignSettingsSectionContext): typeof CAMPAIGN_SETTINGS_SECTIONS {
  return CAMPAIGN_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === 'roster-uploads') return ctx.canSupervise;
    return true;
  });
}

/**
 * The section id a URL hash names. A hash is percent-encoded text typed or pasted by anyone,
 * so a malformed one (`#%E0%A4%A`) is read as written rather than thrown: it names no section.
 */
export function sectionIdOfHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/* ── Which tab a field or a change is on ─────────────────────────────────── */

const BASICS_FIELDS = new Set(['name', 'caller_ids', 'telephony_provider', 'telephony_credential_id']);

/**
 * The tab whose fields show this finding: a body path as the server keys its `details` and
 * `validateConfig` its findings (`calling_window_end`, `disposition_catalog[3].label`,
 * `context_display.facts.0.key`). Anything not named here is on Agents & timing, which holds
 * the rest of the behaviour block (hours, retries, wrap-up, recording, assignment, breaks, the
 * daily target and the number display).
 */
export function settingsTabOfField(field: string): SetupStepId {
  if (BASICS_FIELDS.has(field)) return 'basics';
  if (field.startsWith('context_display')) return 'contacts';
  if (
    field.startsWith('disposition_catalog')
    || field.startsWith('outcome_dispositions')
    || field.startsWith('agent_script')
  ) {
    return 'purpose';
  }
  return 'agents';
}

/**
 * The tab holding an unsaved change, as `changedSettings` names it (`name`, `window.start`,
 * `dispositions`, `customerFacts`, …), plus `staffing` for the agents' ticks.
 */
export function settingsTabOfChange(change: string): SetupStepId {
  if (change === 'name' || change === 'carrier' || change === 'callerIds') return 'basics';
  if (change === 'customerFacts') return 'contacts';
  if (change === 'dispositions' || change === 'outcomeDispositions' || change === 'script') return 'purpose';
  return 'agents';
}
