/*
 * The outcomes untagged soft-phone calls are saved against (docs/softphone.md §3; campaign
 * templates CT11): the soft phone's own list when it has one; otherwise, with
 * `agency_campaign_templates_enabled` on, the outcomes of the account's default template chain
 * (the account's default, the organisation's, built-in), read live at each call, never copied
 * (the soft phone is an account setting, not a campaign); otherwise the built-in outcomes.
 *
 * Read by every place that decides or shows that list, so they cannot disagree: the bootstrap's
 * `untagged.disposition_catalog` (the console's and the agent app's pad), the outcome's
 * settlement (`SoftphoneService.submitDisposition`) and the settings read's `outcomes_follow`
 * (what the settings page shows as "Follow campaign template"). Tagged and inbound calls never
 * read it.
 */
import type { AgencyDisposition, AgencySoftphoneOutcomesFollow, AgencySoftphoneSettings } from '@magick-agency/contracts/agency';
import { softphoneTemplateOutcomes, type TemplateAccountScope } from '../campaign-templates/resolve-effective.js';
import { resolveManualCatalog, softphoneSetsOwnOutcomes } from './manual-disposition.js';

/**
 * What untagged calls follow when the soft phone sets no outcomes (module note): the template
 * and the catalog the calls use (an empty template list read as the built-in one), or null when
 * the soft phone sets its own or the templates flag is off.
 */
export async function untaggedOutcomesFollow(
  scope: TemplateAccountScope,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): Promise<AgencySoftphoneOutcomesFollow | null> {
  if (softphoneSetsOwnOutcomes(settings)) return null;
  const follow = await softphoneTemplateOutcomes(scope);
  if (!follow) return null;
  return { template: follow.template, catalog: resolveManualCatalog(null, false, settings, follow.catalog).catalog };
}

/** The catalog untagged calls are saved against now (module note). */
export async function untaggedCatalog(
  scope: TemplateAccountScope,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): Promise<AgencyDisposition[]> {
  const follow = await untaggedOutcomesFollow(scope, settings);
  return resolveManualCatalog(null, false, settings, follow?.catalog ?? []).catalog;
}
