/*
 * The shape of a campaign's `template_source` (CT9, `AgencyCampaignTemplateSource`), checked by
 * the internal create handler before it stores one. Only the public create path sends it (it
 * strips any a client sent and writes its own, `create-fill.ts`), so a malformed one is a wiring
 * defect: refused as a 400 rather than stored as a record nothing could read.
 */
import {
  AGENCY_CAMPAIGN_TEMPLATE_SCOPES,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { UUID_RE } from '../../utils/uuid.js';

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refIssue(value: unknown, withScope: boolean): boolean {
  if (value === null) return false;
  if (!plain(value)) return true;
  return typeof value['id'] !== 'string' || !UUID_RE.test(value['id'])
    || typeof value['name'] !== 'string'
    || typeof value['version'] !== 'number' || !Number.isInteger(value['version']) || value['version'] < 1
    || (withScope && !(AGENCY_CAMPAIGN_TEMPLATE_SCOPES as readonly unknown[]).includes(value['scope']));
}

/** Why `value` is not an `AgencyCampaignTemplateSource`, or null when it is one. */
export function templateSourceIssue(value: unknown): string | null {
  if (!plain(value)) return 'template_source must be an object';
  if (refIssue(value['template'], true)) return 'template_source.template must be null or a template (id, name, version, scope)';
  if (refIssue(value['based_on'], false)) return 'template_source.based_on must be null or a template (id, name, version)';
  const sections = value['sections'];
  if (!plain(sections)) return 'template_source.sections must be an object';
  const keys = Object.keys(sections);
  if (keys.length !== AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.length
    || !AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.every((k) =>
      (AGENCY_CAMPAIGN_TEMPLATE_SECTION_SOURCES as readonly unknown[]).includes(sections[k]))) {
    return 'template_source.sections must give every section its source';
  }
  return null;
}
