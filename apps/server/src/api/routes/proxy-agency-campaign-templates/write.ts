/*
 * The campaign template writes (docs/campaign-templates.md §6, CT3–CT6, CT10, CT13, CT14): create,
 * replace, make or clear the default, archive and restore. Part of
 * `proxy-agency-campaign-templates.routes.ts`.
 *
 * Who (CT3): `agency.campaign_templates.manage` (the route guard) for an account template of the
 * context account; an organisation template also needs `tenant_admin` or above with an
 * organisation-wide seat (`organisationWriteRefused`, AA1). A template the caller cannot see is
 * `404 campaign_template_not_found`, never a 403.
 *
 * Checks, in this order: the body (`campaign_template_invalid`), the scope
 * (`campaign_template_scope_invalid`), the based-on (a live organisation template of the tenant),
 * each section as a campaign create checks it (`campaign_template_section_invalid`, CT4), then the
 * repository's rules under the scope lock: the version (`409 campaign_template_changed`, CT6), the
 * name (`409 campaign_template_name_taken`, CT13), the default, the archive (`409
 * campaign_template_in_use`, CT14). Every write is audited (`campaign_template.*`, CT9) on success;
 * a default, archive or restore only when the repository says it changed something (two at once
 * audit once). A replace reads its body, size included, before the template.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgencyCampaignTemplateArchiveResponse,
  AgencyCampaignTemplateDefaultResponse,
  AgencyCampaignTemplateInUseRef,
  AgencyCampaignTemplateRestoreResponse,
  AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { accountOnlyPartsIn, diffSections } from '@magick-agency/domain/campaign-templates';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import {
  agencyCampaignTemplateRepository as repo,
  type CampaignTemplateBasedOnRow,
  type CampaignTemplateRecord,
  type CampaignTemplateScope,
} from '../../../db/repositories/agency.repository.js';
import {
  auditTemplate,
  changedSectionKeys,
  organisationWriteRefused,
  readerOf,
  sendTemplateRefusal,
  summaryOf,
  templateGuards,
  templateIdOf,
  templateOf,
} from './shared.js';
import {
  createTemplateSchema,
  replaceTemplateSchema,
  sectionAccountIssues,
  sectionConfigIssues,
  sectionsShapeIssues,
  storedTemplateSections,
} from './validate.js';
import { zodDetails } from '../../../utils/zod-details.js';

/** A repository refusal every content write can meet. */
type ContentRefusal =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'archived' }
  | { ok: false; reason: 'changed'; current_version: number }
  | { ok: false; reason: 'name_taken'; template: { id: string; name: string } }
  | { ok: false; reason: 'limit_reached'; limit: number }
  | { ok: false; reason: 'based_on_not_found' }
  | { ok: false; reason: 'based_on_archived' };

/** The refusal for a repository answer. */
function sendContentRefusal(reply: FastifyReply, refusal: ContentRefusal): FastifyReply {
  switch (refusal.reason) {
    case 'not_found':
      return sendTemplateRefusal(reply, 'campaign_template_not_found');
    case 'archived':
      return sendTemplateRefusal(reply, 'campaign_template_archived');
    case 'changed':
      return sendTemplateRefusal(reply, 'campaign_template_changed', { extra: { current_version: refusal.current_version } });
    case 'name_taken':
      return sendTemplateRefusal(reply, 'campaign_template_name_taken', {
        message: `There is already a template called "${refusal.template.name}" here. Choose another name.`,
        extra: { template: refusal.template },
      });
    case 'limit_reached': {
      const message = `There are already ${refusal.limit} templates here. Archive one you no longer use first.`;
      return sendTemplateRefusal(reply, 'campaign_template_invalid', { message, details: { templates: message } });
    }
    case 'based_on_not_found':
      return sendTemplateRefusal(reply, 'campaign_template_not_found', {
        message: 'The organisation template this is based on was not found.',
      });
    case 'based_on_archived':
      return sendTemplateRefusal(reply, 'campaign_template_archived', {
        message: 'The organisation template this is based on is archived. Choose another, or restore it first.',
      });
  }
}

/** A template's exact scope (the repository's write scope). */
function scopeOf(row: Pick<CampaignTemplateRecord, 'tenant_id' | 'account_id'>): CampaignTemplateScope {
  return { tenantId: row.tenant_id, accountId: row.account_id };
}

/**
 * The content checks shared by create and replace, after the body's shape: the scope's rules, the
 * based-on, and every section (module note), on the sections as a campaign stores them
 * (`storedTemplateSections`). `accountId` null: an organisation template. The sections to store,
 * or null once it has replied.
 */
async function contentRefused(
  request: FastifyRequest,
  reply: FastifyReply,
  accountId: string | null,
  content: { based_on_template_id: string | null; sections: Record<string, Record<string, unknown>> },
): Promise<AgencyCampaignTemplateSections | null> {
  const shape = sectionsShapeIssues(content.sections);
  if (Object.keys(shape).length > 0) {
    sendTemplateRefusal(reply, 'campaign_template_invalid', { details: shape });
    return null;
  }
  const sections = storedTemplateSections(content.sections as AgencyCampaignTemplateSections);

  if (accountId === null) {
    if (content.based_on_template_id !== null) {
      sendTemplateRefusal(reply, 'campaign_template_scope_invalid', {
        message: 'An organisation template is not based on another template.',
        details: { based_on_template_id: 'must be null on an organisation template' },
      });
      return null;
    }
    const parts = accountOnlyPartsIn(sections);
    if (parts.length > 0) {
      sendTemplateRefusal(reply, 'campaign_template_scope_invalid', {
        message: 'An organisation template cannot hold an account’s numbers or call summary profile.',
        details: Object.fromEntries(parts.map((p) => [p, 'is set per account, not for the whole organisation'])),
      });
      return null;
    }
  } else if (content.based_on_template_id !== null) {
    // The repository re-checks under the lock; this tells an account template from a missing one.
    const basedOn = await repo.findVisible({ tenantId: request.tenantId!, accountId }, content.based_on_template_id);
    if (!basedOn) {
      sendContentRefusal(reply, { ok: false, reason: 'based_on_not_found' });
      return null;
    }
    if (basedOn.account_id !== null) {
      sendTemplateRefusal(reply, 'campaign_template_scope_invalid', {
        message: 'An account template can be based on an organisation template only.',
        details: { based_on_template_id: 'must name an organisation template' },
      });
      return null;
    }
    if (basedOn.archived_at !== null) {
      sendContentRefusal(reply, { ok: false, reason: 'based_on_archived' });
      return null;
    }
  }

  const issues = sectionConfigIssues(sections)
    ?? (accountId === null ? null : await sectionAccountIssues({ tenantId: request.tenantId!, accountId }, sections));
  if (issues) {
    sendTemplateRefusal(reply, 'campaign_template_section_invalid', { details: issues.details, extra: { sections: issues.sections } });
    return null;
  }
  return sections;
}

/**
 * The template `:id` the caller may write, else null once it has replied: visible to the reader
 * (404 otherwise), and for an organisation template written by an organisation admin (CT3).
 */
async function writableTemplate(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<CampaignTemplateRecord | null> {
  const id = templateIdOf(request.params.id);
  const row = id === null ? null : await repo.findVisible(readerOf(request), id);
  if (!row) {
    sendTemplateRefusal(reply, 'campaign_template_not_found');
    return null;
  }
  if (row.account_id === null && organisationWriteRefused(request, reply)) return null;
  return row;
}

/** The live account templates an archive was refused for, their accounts named in one read. */
async function inUseRefs(tenantId: string, rows: readonly CampaignTemplateBasedOnRow[]): Promise<AgencyCampaignTemplateInUseRef[]> {
  const accounts = await accountRepository.findByIds([...new Set(rows.map((r) => r.account_id))], tenantId)
    .catch(() => []);
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ id: r.id, name: r.name, account_id: r.account_id, account_name: names.get(r.account_id) ?? null }));
}

export async function registerCampaignTemplateWriteRoutes(app: FastifyInstance): Promise<void> {
  const manage = templateGuards('agency.campaign_templates.manage');

  // ── POST /campaign-templates ────────────────────────────────────────────────
  app.post('/campaign-templates', manage, async (request, reply) => {
    const parsed = createTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: zodDetails(parsed.error, 'body') });
    const body = parsed.data;

    // The scope and the request's context agree: an organisation template is sent without
    // `X-Account-Id` (CT3), an account template with it.
    const accountId = request.accountId ?? null;
    if (body.scope === 'organisation' && accountId !== null) {
      return sendTemplateRefusal(reply, 'campaign_template_scope_invalid', {
        message: 'An organisation template is created without an account. Send it without X-Account-Id.',
      });
    }
    if (body.scope === 'account' && accountId === null) {
      return sendTemplateRefusal(reply, 'campaign_template_scope_invalid', {
        message: 'An account template is created in an account. Send X-Account-Id.',
      });
    }
    if (body.scope === 'organisation' && organisationWriteRefused(request, reply)) return reply;

    const content = {
      name: body.name,
      description: body.description ?? null,
      based_on_template_id: body.based_on_template_id?.toLowerCase() ?? null,
      sections: body.sections as AgencyCampaignTemplateSections,
    };
    const sections = await contentRefused(request, reply, accountId, content);
    if (!sections) return reply;

    const scope: CampaignTemplateScope = { tenantId: request.tenantId!, accountId };
    const created = await repo.create(scope, { ...content, sections }, { actorUserId: request.user?.id ?? null, makeDefault: body.make_default === true });
    if (!created.ok) return sendContentRefusal(reply, created);
    const template = created.template;
    auditTemplate(request, 'campaign_template.created', template, {
      sections: Object.keys(template.sections),
      based_on_template_id: template.based_on_template_id,
    });
    if (template.is_default) {
      auditTemplate(request, 'campaign_template.default_set', template, { replaced: created.replaced });
    }
    return reply.code(201).send(await templateOf(request, template));
  });

  // ── PUT /campaign-templates/:id ─────────────────────────────────────────────
  app.put<{ Params: { id: string } }>('/campaign-templates/:id', manage, async (request, reply) => {
    // The body first, its size included, before anything is read.
    const parsed = replaceTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: zodDetails(parsed.error, 'body') });
    const body = parsed.data;
    const row = await writableTemplate(request, reply);
    if (!row) return reply;
    // Archived: refused before its content is judged (the repository says the same under the lock).
    if (row.archived_at !== null) return sendTemplateRefusal(reply, 'campaign_template_archived');

    const content = {
      name: body.name,
      description: body.description,
      based_on_template_id: body.based_on_template_id?.toLowerCase() ?? null,
      sections: body.sections as AgencyCampaignTemplateSections,
    };
    const sections = await contentRefused(request, reply, row.account_id, content);
    if (!sections) return reply;

    const replaced = await repo.replace(scopeOf(row), row.id, { ...content, sections, expected_version: body.expected_version }, {
      actorUserId: request.user?.id ?? null,
    });
    if (!replaced.ok) return sendContentRefusal(reply, replaced);
    const template = replaced.template;
    auditTemplate(request, 'campaign_template.updated', template, {
      from_version: row.version,
      to_version: template.version,
      sections_changed: changedSectionKeys(diffSections(row.sections, template.sections)),
      ...(row.name !== template.name ? { renamed: { from: row.name, to: template.name } } : {}),
      ...(row.based_on_template_id !== template.based_on_template_id
        ? { based_on_changed: { from: row.based_on_template_id, to: template.based_on_template_id } }
        : {}),
    });
    return reply.send(await templateOf(request, template));
  });

  // ── POST /campaign-templates/:id/default ────────────────────────────────────
  app.post<{ Params: { id: string } }>('/campaign-templates/:id/default', manage, async (request, reply) => {
    const row = await writableTemplate(request, reply);
    if (!row) return reply;
    const result = await repo.setDefault(scopeOf(row), row.id);
    if (!result.ok) return sendContentRefusal(reply, result);
    if (result.changed) auditTemplate(request, 'campaign_template.default_set', result.template, { replaced: result.replaced });
    const body: AgencyCampaignTemplateDefaultResponse = { template: await summaryOf(request, result.template), replaced: result.replaced };
    return reply.send(body);
  });

  // ── DELETE /campaign-templates/:id/default ──────────────────────────────────
  app.delete<{ Params: { id: string } }>('/campaign-templates/:id/default', manage, async (request, reply) => {
    const row = await writableTemplate(request, reply);
    if (!row) return reply;
    const result = await repo.clearDefault(scopeOf(row), row.id);
    if (!result.ok) return sendContentRefusal(reply, result);
    if (result.changed) auditTemplate(request, 'campaign_template.default_cleared', result.template);
    const body: AgencyCampaignTemplateDefaultResponse = { template: await summaryOf(request, result.template), replaced: null };
    return reply.send(body);
  });

  // ── POST /campaign-templates/:id/archive ────────────────────────────────────
  app.post<{ Params: { id: string } }>('/campaign-templates/:id/archive', manage, async (request, reply) => {
    const row = await writableTemplate(request, reply);
    if (!row) return reply;
    const result = await repo.archive(scopeOf(row), row.id, { actorUserId: request.user?.id ?? null });
    if (!result.ok && result.reason === 'in_use') {
      const templates = await inUseRefs(row.tenant_id, result.templates);
      return sendTemplateRefusal(reply, 'campaign_template_in_use', {
        message: `Account templates are based on this organisation template: ${templates.map((t) => `"${t.name}"`).join(', ')}. Change them to follow another template first.`,
        extra: { templates },
      });
    }
    if (!result.ok) return sendContentRefusal(reply, result);
    if (result.changed) {
      auditTemplate(request, 'campaign_template.archived', result.template, { default_cleared: result.default_cleared });
    }
    const body: AgencyCampaignTemplateArchiveResponse = {
      template: await summaryOf(request, result.template),
      default_cleared: result.default_cleared,
    };
    return reply.send(body);
  });

  // ── POST /campaign-templates/:id/restore ────────────────────────────────────
  app.post<{ Params: { id: string } }>('/campaign-templates/:id/restore', manage, async (request, reply) => {
    const row = await writableTemplate(request, reply);
    if (!row) return reply;
    const result = await repo.restore(scopeOf(row), row.id);
    if (!result.ok) return sendContentRefusal(reply, result);
    if (result.changed) auditTemplate(request, 'campaign_template.restored', result.template);
    const body: AgencyCampaignTemplateRestoreResponse = { template: await summaryOf(request, result.template) };
    return reply.send(body);
  });
}
