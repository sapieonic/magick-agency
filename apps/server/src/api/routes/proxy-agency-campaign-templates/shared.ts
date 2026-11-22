/*
 * What the campaign template routes share: the guards (RBAC, then the flag), the refusal body,
 * who may write which scope (CT3), the wire shapes and the audit row. Part of
 * `proxy-agency-campaign-templates.routes.ts`.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { ROLE_HIERARCHY, type Permission } from '@magick-agency/contracts/rbac';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';
import {
  type AgencyCampaignTemplate,
  type AgencyCampaignTemplateFollows,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSummary,
  type AgencyCampaignTemplateVersion,
  type AgencyCampaignTemplateVersionSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { sectionKeysSet } from '@magick-agency/domain/campaign-templates';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import type { PlatformAuditAction } from '../../../audit/platform/catalog.js';
import {
  agencyCampaignTemplateRepository,
  type CampaignTemplateReader,
  type CampaignTemplateRecord,
  type CampaignTemplateVersionRecord,
} from '../../../db/repositories/agency.repository.js';
import {
  campaignTemplatesEnabled,
  followedTemplate,
  templateScopeOf,
} from '../../../agency/campaign-templates/resolve-effective.js';
import { tenantWideSeatRefused } from '../helpers/tenant-wide-seat.js';
import { UUID_RE } from '../../../utils/uuid.js';

/** The flag gate's refusal: the dialer gate's body shape (`helpers/dialer-gate.ts`), for this page. */
export const CAMPAIGN_TEMPLATES_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Campaign templates are not enabled for this account.',
} as const;

export { sendTemplateRefusal } from '../helpers/campaign-template-refusal.js';

/**
 * The route-level guards: the RBAC floor (`agency.campaigns.write` for the reads,
 * `agency.campaign_templates.manage` for the writes, both for apply; CT3), then the flag, else
 * `403 feature_disabled` before any body is read (CT17).
 */
export function templateGuards(...permissions: Permission[]): { preHandler: preHandlerAsyncHookHandler[] } {
  const flagGate: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!(await campaignTemplatesEnabled(request.tenantId!, request.accountId))) {
      return reply.code(403).send(CAMPAIGN_TEMPLATES_DISABLED_BODY);
    }
  };
  return { preHandler: [...permissions.map((p) => requirePermission(p)), flagGate] };
}

/** The reader of the request: its tenant and context account (none: organisation templates only). */
export function readerOf(request: FastifyRequest): CampaignTemplateReader {
  return { tenantId: request.tenantId!, accountId: request.accountId ?? null };
}

/** A path id, lower-cased, or null when it is not a UUID (then not found, never a `22P02`). */
export function templateIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * CT3: may the caller write an organisation template? `tenant_admin` or above (the RBAC 403
 * otherwise, as `requirePermission` answers), with an organisation-wide seat (AA1:
 * `tenant_wide_membership_required`). False once it has replied. An account template needs only
 * the route's `agency.campaign_templates.manage`.
 */
export function organisationWriteRefused(request: FastifyRequest, reply: FastifyReply): boolean {
  const role = request.membership?.role;
  if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.tenant_admin) {
    void reply.code(403).send({
      error: 'Forbidden',
      message: 'Insufficient permissions. Organisation templates are kept by organisation admins.',
    });
    return true;
  }
  return tenantWideSeatRefused(
    request,
    reply,
    'Your admin access covers one account, not the whole organisation, so you cannot change organisation templates. Ask an admin with access to the whole organisation.',
  );
}

// ── The wire ─────────────────────────────────────────────────────────────────

function actor(id: string | null, names: ReadonlyMap<string, string | null>): AgencyCampaignActor | null {
  return id === null ? null : { user_id: id, name: names.get(id) ?? null };
}

const iso = (d: Date | string): string => new Date(d).toISOString();

/**
 * The names of every person the rows name (who saved, who archived), in one read; a failed read
 * names nobody (`agentNamesOrNone`), never a failed answer.
 */
export function namesFor(
  rows: ReadonlyArray<Pick<CampaignTemplateRecord, 'updated_by' | 'archived_by'> | Pick<CampaignTemplateVersionRecord, 'saved_by'>>,
  tenantId: string,
): Promise<Map<string, string | null>> {
  const ids = rows.flatMap((r) => ('saved_by' in r ? [r.saved_by] : [r.updated_by, r.archived_by]));
  return agentNamesOrNone(ids, tenantId, 'campaign templates');
}

/**
 * The based-on templates the rows name, by id: those among `rows` themselves, and the rest in one
 * read (an organisation template archived since, or not in a list of the other state).
 */
export async function basedOnFor(
  reader: CampaignTemplateReader,
  rows: readonly CampaignTemplateRecord[],
): Promise<Map<string, CampaignTemplateRecord>> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = [...new Set(rows.map((r) => r.based_on_template_id).filter((id): id is string => id !== null && !byId.has(id)))];
  for (const row of await agencyCampaignTemplateRepository.findManyVisible(reader, missing)) byId.set(row.id, row);
  return byId;
}

/** One template as a list row. */
export function templateSummaryToWire(
  row: CampaignTemplateRecord,
  names: ReadonlyMap<string, string | null>,
  templates: ReadonlyMap<string, CampaignTemplateRecord>,
): AgencyCampaignTemplateSummary {
  const basedOn = row.based_on_template_id ? templates.get(row.based_on_template_id) ?? null : null;
  return {
    id: row.id,
    scope: templateScopeOf(row),
    account_id: row.account_id,
    name: row.name,
    description: row.description,
    is_default: row.is_default,
    version: row.version,
    based_on: basedOn
      ? { id: basedOn.id, name: basedOn.name, version: basedOn.version, archived: basedOn.archived_at !== null }
      : null,
    sections_set: sectionKeysSet(row.sections),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    updated_by: actor(row.updated_by, names),
    archived_at: row.archived_at ? iso(row.archived_at) : null,
    archived_by: actor(row.archived_by, names),
  };
}

/** A list row's summary, its people named and its based-on read: for the write routes' answers. */
export async function summaryOf(request: FastifyRequest, row: CampaignTemplateRecord): Promise<AgencyCampaignTemplateSummary> {
  const reader = readerOf(request);
  const [names, templates] = await Promise.all([namesFor([row], reader.tenantId), basedOnFor(reader, [row])]);
  return templateSummaryToWire(row, names, templates);
}

/** One template with its sections and the organisation template it follows (CT10). */
export async function templateOf(request: FastifyRequest, row: CampaignTemplateRecord): Promise<AgencyCampaignTemplate> {
  const reader = readerOf(request);
  const [summary, followed] = await Promise.all([summaryOf(request, row), followedTemplate(reader, row)]);
  const follows: AgencyCampaignTemplateFollows | null = followed
    ? {
      id: followed.id,
      name: followed.name,
      version: followed.version,
      via: row.based_on_template_id === followed.id ? 'based_on' : 'organisation_default',
      archived: followed.archived_at !== null,
      sections: followed.sections,
    }
    : null;
  return { ...summary, sections: row.sections, follows };
}

/** One saved state as a history row. */
export function versionSummaryToWire(
  row: CampaignTemplateVersionRecord,
  names: ReadonlyMap<string, string | null>,
): AgencyCampaignTemplateVersionSummary {
  return {
    version: row.version,
    name: row.name,
    based_on_template_id: row.based_on_template_id,
    sections_set: sectionKeysSet(row.sections),
    saved_at: iso(row.saved_at),
    saved_by: actor(row.saved_by, names),
  };
}

/** One saved state with its sections. */
export function versionToWire(row: CampaignTemplateVersionRecord, names: ReadonlyMap<string, string | null>): AgencyCampaignTemplateVersion {
  return { ...versionSummaryToWire(row, names), template_id: row.template_id, sections: row.sections };
}

// ── The audit (CT9) ──────────────────────────────────────────────────────────

/** The template actions of `platform_audit_log`. */
export type CampaignTemplateAuditAction = Extract<PlatformAuditAction, `campaign_template.${string}`>;

/**
 * One `campaign_template.*` row, filed under the template (`resource_id`); an account template's
 * under its account too (`account_id`), an organisation template's under the tenant alone, unless
 * `filed.accountId` names the account the write acted in (an apply changes one account's drafts,
 * whichever template it applies). `details` always carry the template's scope and version; each
 * route adds what it changed.
 */
export function auditTemplate(
  request: FastifyRequest,
  action: CampaignTemplateAuditAction,
  row: Pick<CampaignTemplateRecord, 'id' | 'tenant_id' | 'account_id' | 'name' | 'version'>,
  details: Record<string, unknown> = {},
  filed: { accountId?: string } = {},
): void {
  const accountId = filed.accountId ?? row.account_id;
  platformAuditLogger.log({
    tenant_id: row.tenant_id,
    ...(accountId ? { account_id: accountId } : {}),
    ...requestAuditActor(request),
    action,
    resource_type: 'campaign_template',
    resource_id: row.id,
    details: { template_id: row.id, name: row.name, scope: templateScopeOf(row), version: row.version, ...details },
    ip_address: request.ip,
  });
}

/** The section keys a diff names, for an audit row. */
export function changedSectionKeys(diff: ReadonlyArray<{ section: AgencyCampaignTemplateSectionKey }>): AgencyCampaignTemplateSectionKey[] {
  return diff.map((d) => d.section);
}
