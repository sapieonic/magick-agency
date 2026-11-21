/**
 * The sections of a campaign's Settings page (`/agency/campaigns/:id/settings`), in page order.
 * Each `id` is the section's anchor, so `…/settings#calling-hours` opens the page at it; the
 * page's section nav lists these, and search can deep-link to them by their keywords.
 *
 * A section shows only when it has something on the page. Every campaign has Agents: its break
 * limits are every campaign's (LF27), beside contact assignment and inbound calls when those are
 * on. Lifecycle and uploads needs `agency.supervise`, the floor of its reads. The ids are stable;
 * rename a label freely, never an id, since links carry them.
 */
export const CAMPAIGN_SETTINGS_SECTIONS: { id: string; label: string; keywords: string[] }[] = [
  {
    id: 'general',
    label: 'General',
    keywords: ['name', 'rename', 'campaign name', 'title'],
  },
  {
    id: 'caller-ids',
    label: 'Caller IDs',
    keywords: ['caller id', 'caller ids', 'number', 'numbers', 'cli', 'dial from', 'carrier', 'carrier account', 'telephony'],
  },
  {
    id: 'calling-hours',
    label: 'Calling hours',
    keywords: ['hours', 'calling window', 'window', 'time zone', 'timezone', 'days', 'weekdays', 'schedule', 'start time', 'end time'],
  },
  {
    id: 'dialling-retries',
    label: 'Dialling and retries',
    keywords: ['retry', 'retries', 'redial', 'attempts', 'busy', 'no answer', 'gap between tries', 'abandonment', 'abandon rate', 'ceiling', 'auto pause', 'pacing'],
  },
  {
    id: 'wrap-up',
    label: 'Wrap-up and outcomes',
    keywords: ['wrap-up', 'wrapup', 'outcomes', 'dispositions', 'disposition codes', 'number keys', 'unanswered calls', 'voicemail', 'auto return', 'after-call work', 'icon', 'picture', 'outcome picture'],
  },
  {
    id: 'recording',
    label: 'Recording',
    keywords: ['record', 'recording', 'call recording', 'call summary', 'summary', 'summary profile', 'analysis profile', 'transcript'],
  },
  {
    id: 'agents',
    label: 'Agents',
    keywords: ['contact assignment', 'assignment mode', 'assign contacts', 'owner', 'own contacts', 'agent retry', 'sticky agent', 'inbound', 'put callers through', 'break', 'breaks', 'break limit', 'break reasons', 'tea', 'lunch', 'break picture'],
  },
  {
    // Agent station (AS6, AS9, AS19): the daily target, the number display and the customer card
    // (the name, the line under it, up to 4 facts with their names, keys and highlight, and how
    // each column is read).
    id: 'agent-screen',
    label: 'What agents see',
    keywords: [
      'daily target', 'target', 'calls a day', 'goal', 'phone number', 'full number', 'hidden number', 'mask', 'masked',
      'hide number', 'customer card', 'customer facts', 'facts', 'fact name', 'highlight', 'key', 'customer name',
      'line under the name', 'place', 'column', 'money', 'date', 'number', 'yes / no', 'full and half',
    ],
  },
  {
    // Agent station (BE-8, AS19): the opening line and the steps agents read out, with the card's keys.
    id: 'script',
    label: 'Script',
    keywords: ['script', 'opening line', 'what to say', 'steps', 'pitch', 'placeholder', 'keys'],
  },
  {
    // The page shows the campaign's lifecycle and its roster upload history here.
    id: 'roster-uploads',
    label: 'Lifecycle and uploads',
    keywords: ['uploads', 'upload history', 'roster', 'contact list', 'csv', 'file', 'lifecycle', 'started', 'paused', 'stopped'],
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
