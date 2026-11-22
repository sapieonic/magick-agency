import { formatCount } from './format/number';
import { AGENCY_CALL_SETTINGS_UNFILED_DAYS, type AgencyCallSettingsAgentRef } from '../types/call-settings';

/**
 * Settings › Calls (`docs/call-log.md` §5), in the proposal's words. An admin's page, so it says
 * "campaign", "soft phone" and "inbound" as the rest of Settings does (the agent's station does
 * not: `sideViewCopy.ts`).
 */
export const CALL_SETTINGS_COPY = {
  title: 'Calls',
  /** Beside the count of calls filed under no campaign: All calls, on those calls. */
  seeUnfiled: 'See them in All calls',
  description:
    'Whether every call in this account has to be filed under a campaign. It covers calls agents make from the soft phone and calls customers make to you.',
  switchLabel: 'Every call must belong to a campaign',
  help:
    'When this is on, agents cannot dial from the soft phone without choosing a campaign, and every customer who rings is filed under a campaign. Calls made before you switch it on are not changed.',
  softphoneReady: 'Soft phone: agents will be asked to choose a campaign.',
  softphoneOn: 'Soft phone: agents are asked to choose a campaign before they dial.',
  inboundReady: 'Inbound: every inbound number has a campaign for unknown callers.',
  inboundOff: 'Inbound: inbound calls are not switched on for this account, so its inbound numbers are not checked.',
  chooseCampaign: 'Choose a campaign',
  openCampaigns: 'Open campaigns',
  confirmBody: 'From now, no call can be made or saved without a campaign.',
  switchOn: 'Switch on',
  switchingOn: 'Switching on…',
  cancel: 'Cancel',
  switchOff: 'Switch off',
  switchingOff: 'Switching off…',
  onNow: 'On: every new call needs a campaign.',
  offNow: 'Off: calls can be made and saved without a campaign.',
  blocked: 'This cannot be switched on yet. Choose a campaign for unknown callers on each inbound number first.',
  switchedOn: 'Every call must now belong to a campaign.',
  switchedOff: 'Calls no longer have to belong to a campaign.',
  loadFailed: 'We couldn’t load the call settings.',
  saveFailed: 'That didn’t save. Try again in a moment.',
  forbidden: 'Only an account admin can see and change the call settings.',
  ready: 'Ready',
  notReady: 'Not ready',
  note: 'For information',
} as const;

/** "Switch on for Acme Collections?" */
export function confirmTitle(accountName: string | null | undefined): string {
  return `Switch on for ${accountName ?? 'this account'}?`;
}

/** "2 inbound numbers have no campaign for unknown callers: Sales line, Support line." (the names are rendered as links beside it). */
export function routesMissingLine(count: number): string {
  return count === 1
    ? '1 inbound number has no campaign for unknown callers:'
    : `${formatCount(count)} inbound numbers have no campaign for unknown callers:`;
}

/**
 * "4 agents are not on any running campaign and will not be able to dial: Arjun Mehta, …." With
 * the setting on: "cannot dial". The names are the first few; "and 12 more" says the rest.
 */
export function agentsWithoutCampaignLine(agents: readonly AgencyCallSettingsAgentRef[], total: number, on: boolean): string {
  const names = agents.map((a) => a.name ?? 'Someone with no name').join(', ');
  const more = total - agents.length;
  const who = total === 1 ? '1 agent is' : `${formatCount(total)} agents are`;
  const what = on ? 'cannot dial' : 'will not be able to dial';
  return `${who} not on any running campaign and ${what}: ${names}${more > 0 ? `, and ${formatCount(more)} more` : ''}.`;
}

/** "In the last 30 days, 41 calls were not filed under a campaign." */
export function unfiledCallsLine(count: number): string {
  const days = AGENCY_CALL_SETTINGS_UNFILED_DAYS;
  if (count === 0) return `In the last ${days} days, every call was filed under a campaign.`;
  return count === 1
    ? `In the last ${days} days, 1 call was not filed under a campaign.`
    : `In the last ${days} days, ${formatCount(count)} calls were not filed under a campaign.`;
}

/**
 * Said in the Stop and Archive confirmations of a campaign that an inbound number files its
 * unknown callers under: "This campaign receives unknown callers on Sales line. Choose another
 * campaign for that route first." Null when no route does.
 */
export function unknownCallersWarning(routeNames: readonly string[]): string | null {
  if (routeNames.length === 0) return null;
  const list = routeNames.length === 1
    ? routeNames[0]!
    : `${routeNames.slice(0, -1).join(', ')} and ${routeNames[routeNames.length - 1]!}`;
  return `This campaign receives unknown callers on ${list}. Choose another campaign for ${routeNames.length === 1 ? 'that route' : 'those routes'} first.`;
}
