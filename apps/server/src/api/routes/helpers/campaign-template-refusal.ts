/*
 * The campaign template refusal body (`AgencyCampaignTemplateErrorCode`, contracts `errors.ts` §10),
 * sent by the template routes (`proxy-agency-campaign-templates/`) and by the campaign create when
 * its `template_id` cannot be used (CT8, `proxy-agency-campaigns/crud.ts`).
 */
import type { FastifyReply } from 'fastify';
import {
  AGENCY_CAMPAIGN_TEMPLATE_ERROR_STATUS,
  type AgencyCampaignTemplateErrorCode,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { sendRefusal, type RefusalOptions } from './refusal.js';

/** The words of each refusal; a route may say more (the name taken, the scope that does not fit). */
export const CAMPAIGN_TEMPLATE_MESSAGES: Record<AgencyCampaignTemplateErrorCode, string> = {
  campaign_template_not_found: 'Campaign template not found.',
  campaign_template_changed: 'Someone saved this template after you opened it. Reload it to see their changes, then save again.',
  campaign_template_name_taken: 'There is already a template with this name here. Choose another name.',
  campaign_template_in_use: 'Account templates are based on this organisation template. Change them to follow another template first.',
  campaign_template_scope_invalid: 'This does not fit an organisation template.',
  campaign_template_section_invalid: 'Some settings in this template are not valid. Correct the marked fields.',
  campaign_template_archived: 'This template is archived. Restore it first.',
  campaign_template_invalid: 'The template is not valid. Correct the marked fields.',
};

/** The `error` title of each status a template refusal has. */
const TITLES: Readonly<Record<number, string>> = { 400: 'Bad Request', 404: 'Not Found', 409: 'Conflict' };

/**
 * `{ error, code, message, details? }` with the code's status (`AGENCY_CAMPAIGN_TEMPLATE_ERROR_STATUS`),
 * plus the fields a code carries (`extra`: `current_version`, `template`, `templates`, `sections`).
 */
export function sendTemplateRefusal(
  reply: FastifyReply,
  code: AgencyCampaignTemplateErrorCode,
  opts: { message?: string; extra?: Record<string, unknown> } & Pick<RefusalOptions, 'details'> = {},
): FastifyReply {
  const status = AGENCY_CAMPAIGN_TEMPLATE_ERROR_STATUS[code];
  const message = opts.message ?? CAMPAIGN_TEMPLATE_MESSAGES[code];
  if (!opts.extra) return sendRefusal(reply, status, code, message, opts.details ? { details: opts.details } : {});
  return reply.code(status).send({
    error: TITLES[status] ?? 'Error',
    code,
    message,
    ...opts.extra,
    ...(opts.details ? { details: opts.details } : {}),
  });
}
