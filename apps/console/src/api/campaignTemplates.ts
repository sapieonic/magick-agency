import { API_BASE } from '../config';
import { apiFetch } from './client';
import type {
  AgencyCampaignTemplate,
  AgencyCampaignTemplateApplyRequest,
  AgencyCampaignTemplateApplyResponse,
  AgencyCampaignTemplateArchiveResponse,
  AgencyCampaignTemplateDefaultResponse,
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateListResponse,
  AgencyCampaignTemplateRestoreResponse,
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSummary,
  AgencyCampaignTemplateVersion,
  AgencyCampaignTemplateVersionsResponse,
  AgencyCreateCampaignTemplateRequest,
  AgencyReplaceCampaignTemplateRequest,
} from '@magick-agency/contracts/api/agency/campaign-templates';

/**
 * Campaign templates (`docs/campaign-templates.md` §6), through the server's `/proxy/agency`.
 *
 * Reads (the list, one template, its versions, the filled-in form) and account-template writes are
 * sent with the account (`X-Account-Id`), as every agency call is. **An organisation template's
 * writes are sent WITHOUT it**, as the Accounts page's create is (`api/accounts.ts`): with the
 * header the server would prefer a seat scoped to that account over the caller's organisation-wide
 * one, and only the organisation-wide seat may write an organisation template (CT3, 403
 * `tenant_wide_membership_required`). `writeAccount` picks which by the template's scope.
 *
 * Refusals arrive as `ApiError` (`./client.ts`, `parseApiErrorBody`); their codes are the
 * contract's `AgencyCampaignTemplateErrorCode`s, read with `errorCode` (`utils/agencyErrors`).
 */

const BASE = `${API_BASE}/proxy/agency/campaign-templates`;

/** The account header a write of a template in `scope` carries: none for the organisation's. */
function writeAccount(scope: AgencyCampaignTemplateScope, accountId: string | undefined): string | undefined {
  return scope === 'organisation' ? undefined : accountId;
}

const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** `GET /campaign-templates[?archived=true]`: the account's templates, then the organisation's. */
export async function listCampaignTemplates(
  tenantId: string | undefined,
  accountId: string | undefined,
  options: { archived?: boolean } = {},
): Promise<AgencyCampaignTemplateSummary[]> {
  const query = options.archived ? '?archived=true' : '';
  const res = await apiFetch<AgencyCampaignTemplateListResponse>(`${BASE}${query}`, {}, tenantId, accountId);
  return res.templates;
}

/** `GET /campaign-templates/:id`: one template with its sections and what it follows. */
export function getCampaignTemplate(id: string, tenantId?: string, accountId?: string): Promise<AgencyCampaignTemplate> {
  return apiFetch<AgencyCampaignTemplate>(path(id), {}, tenantId, accountId);
}

/** `POST /campaign-templates` → 201. An organisation template is sent without the account. */
export function createCampaignTemplate(
  body: AgencyCreateCampaignTemplateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplate> {
  return apiFetch<AgencyCampaignTemplate>(
    BASE,
    { method: 'POST', body: JSON.stringify(body) },
    tenantId,
    writeAccount(body.scope, accountId),
  );
}

/** `PUT /campaign-templates/:id`: replaces the content; 409 `campaign_template_changed` on a stale version. */
export function replaceCampaignTemplate(
  id: string,
  scope: AgencyCampaignTemplateScope,
  body: AgencyReplaceCampaignTemplateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplate> {
  return apiFetch<AgencyCampaignTemplate>(
    path(id),
    { method: 'PUT', body: JSON.stringify(body) },
    tenantId,
    writeAccount(scope, accountId),
  );
}

/** `POST …/default` (make it the scope's default) or `DELETE …/default` (the scope has none). */
export function setCampaignTemplateDefault(
  id: string,
  scope: AgencyCampaignTemplateScope,
  isDefault: boolean,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateDefaultResponse> {
  return apiFetch<AgencyCampaignTemplateDefaultResponse>(
    `${path(id)}/default`,
    { method: isDefault ? 'POST' : 'DELETE' },
    tenantId,
    writeAccount(scope, accountId),
  );
}

/** `POST …/archive` (CT14): 409 `campaign_template_in_use` while a live account template is based on it. */
export function archiveCampaignTemplate(
  id: string,
  scope: AgencyCampaignTemplateScope,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateArchiveResponse> {
  return apiFetch<AgencyCampaignTemplateArchiveResponse>(
    `${path(id)}/archive`,
    { method: 'POST' },
    tenantId,
    writeAccount(scope, accountId),
  );
}

/** `POST …/restore`: live again, not a default; the name is checked again. */
export function restoreCampaignTemplate(
  id: string,
  scope: AgencyCampaignTemplateScope,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateRestoreResponse> {
  return apiFetch<AgencyCampaignTemplateRestoreResponse>(
    `${path(id)}/restore`,
    { method: 'POST' },
    tenantId,
    writeAccount(scope, accountId),
  );
}

/** `GET …/versions`: the history, newest first. */
export async function listCampaignTemplateVersions(
  id: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateVersionsResponse['versions']> {
  const res = await apiFetch<AgencyCampaignTemplateVersionsResponse>(`${path(id)}/versions`, {}, tenantId, accountId);
  return res.versions;
}

/** `GET …/versions/:n`: one saved state with its sections. */
export function getCampaignTemplateVersion(
  id: string,
  version: number,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateVersion> {
  return apiFetch<AgencyCampaignTemplateVersion>(`${path(id)}/versions/${version}`, {}, tenantId, accountId);
}

/**
 * `GET /campaign-templates/effective[?template_id=]`: the settings a new campaign of the account
 * starts from, the named template's or the account's default chain's.
 */
export function getEffectiveCampaignTemplate(
  templateId: string | null,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateEffective> {
  const query = templateId ? `?template_id=${encodeURIComponent(templateId)}` : '';
  return apiFetch<AgencyCampaignTemplateEffective>(`${BASE}/effective${query}`, {}, tenantId, accountId);
}

/**
 * `POST …/apply` (CT16): the chosen sections to the chosen draft campaigns of the account. Always
 * sent with the account, whatever the template's scope: the campaigns are the account's.
 */
export function applyCampaignTemplate(
  id: string,
  body: AgencyCampaignTemplateApplyRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignTemplateApplyResponse> {
  return apiFetch<AgencyCampaignTemplateApplyResponse>(
    `${path(id)}/apply`,
    { method: 'POST', body: JSON.stringify(body) },
    tenantId,
    accountId,
  );
}
