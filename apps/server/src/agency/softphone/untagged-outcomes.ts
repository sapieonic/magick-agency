/*
 * The outcomes untagged soft-phone calls are saved against (docs/softphone.md §3; campaign
 * templates CT11): the soft phone's own list when it has one; otherwise, with
 * `agency_campaign_templates_enabled` on, the outcomes of the account's default template chain
 * (the account's default, the organisation's, built-in), read live at each call, never copied
 * (the soft phone is an account setting, not a campaign); otherwise the built-in outcomes.
 *
 * The followed catalog is one the soft phone itself would accept: each entry passes through the
 * soft phone's own catalog rules (`asSoftphoneCatalog`: no agent override, no promise to pay, the
 * outcome kept), so an untagged call is never offered what its settings page would refuse.
 *
 * Read by every place that decides or shows that list, so they cannot disagree: the bootstrap's
 * `untagged.disposition_catalog` (the console's and the agent app's pad), the outcome's
 * settlement (`SoftphoneService.submitDisposition`) and the settings read and save's
 * `outcomes_template` (what the settings page shows as "Follow campaign template"). Tagged and
 * inbound calls never read it.
 */
import type { AgencyDisposition, AgencySoftphoneOutcomesTemplate, AgencySoftphoneSettings } from '@magick-agency/contracts/agency';
import { softphoneTemplateOutcomes, type TemplateAccountScope } from '../campaign-templates/resolve-effective.js';
import { asSoftphoneCatalog } from '../../db/repositories/agency.repository.js';
import { resolveManualCatalog, softphoneSetsOwnOutcomes } from './manual-disposition.js';

/** No list of the soft phone's own: what "Follow campaign template" is resolved against. */
const FOLLOWING: Pick<AgencySoftphoneSettings, 'disposition_catalog'> = { disposition_catalog: [] };

/**
 * What "Follow campaign template" gives (module note): the template and the catalog untagged calls
 * use while the soft phone sets none of its own (an empty template list read as the built-in one),
 * WHETHER OR NOT it sets one now, so the settings page can name it before the operator chooses it.
 * Null while the templates flag is off for the account.
 */
export async function followedOutcomesTemplate(scope: TemplateAccountScope): Promise<AgencySoftphoneOutcomesTemplate | null> {
  const follow = await softphoneTemplateOutcomes(scope);
  if (!follow) return null;
  return {
    template: follow.template,
    disposition_catalog: resolveManualCatalog(null, false, FOLLOWING, asSoftphoneCatalog(follow.catalog)).catalog,
  };
}

/**
 * What untagged calls follow NOW (module note): {@link followedOutcomesTemplate}, or null when the
 * soft phone sets its own list (then nothing is read) or the templates flag is off.
 */
export async function untaggedOutcomesTemplate(
  scope: TemplateAccountScope,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): Promise<AgencySoftphoneOutcomesTemplate | null> {
  return softphoneSetsOwnOutcomes(settings) ? null : followedOutcomesTemplate(scope);
}

/** The catalog untagged calls are saved against now (module note). */
export async function untaggedCatalog(
  scope: TemplateAccountScope,
  settings: Pick<AgencySoftphoneSettings, 'disposition_catalog'>,
): Promise<AgencyDisposition[]> {
  const follow = await untaggedOutcomesTemplate(scope, settings);
  return resolveManualCatalog(null, false, settings, follow?.disposition_catalog ?? []).catalog;
}
