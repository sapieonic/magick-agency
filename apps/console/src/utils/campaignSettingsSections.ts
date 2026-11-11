/**
 * The sections of a campaign's Settings page (`/agency/campaigns/:id/settings`), in page order.
 * Each `id` is the section's anchor, so `…/settings#calling-hours` opens the page at it; the
 * page's section nav lists these, and search can deep-link to them by their keywords.
 *
 * A section shows only when it has something on the page: Agents needs contact assignment or
 * inbound calls on (or contact-assignment settings left from before it was turned off), and
 * Lifecycle and uploads needs `agency.supervise`, the floor of its reads. The ids are stable;
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
    keywords: ['wrap-up', 'wrapup', 'outcomes', 'dispositions', 'disposition codes', 'number keys', 'unanswered calls', 'voicemail', 'auto return', 'after-call work'],
  },
  {
    id: 'recording',
    label: 'Recording',
    keywords: ['record', 'recording', 'call recording', 'call summary', 'summary', 'summary profile', 'analysis profile', 'transcript'],
  },
  {
    id: 'agents',
    label: 'Agents',
    keywords: ['contact assignment', 'assignment mode', 'assign contacts', 'owner', 'own contacts', 'agent retry', 'sticky agent', 'inbound', 'put callers through'],
  },
  {
    // The page shows the campaign's lifecycle and its roster upload history here.
    id: 'roster-uploads',
    label: 'Lifecycle and uploads',
    keywords: ['uploads', 'upload history', 'roster', 'contact list', 'csv', 'file', 'lifecycle', 'started', 'paused', 'stopped'],
  },
];
