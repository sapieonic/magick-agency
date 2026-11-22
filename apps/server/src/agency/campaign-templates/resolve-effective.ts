/*
 * Campaign templates' fill-in on the server (docs/campaign-templates.md §5, rulings CT2, CT5,
 * CT8, CT10, CT11, CT15): which template a new campaign of an account starts from, the
 * organisation template it follows, what the account may have, and the settings that come out,
 * with the server's own notes. ONE function for every reader, so they cannot disagree:
 *
 *  - `GET /proxy/agency/campaign-templates/effective`, the form New campaign opens on;
 *  - the campaign create (`POST /proxy/agency/campaigns`, CT8), which fills the sections a body
 *    leaves out and records where each came from (CT9);
 *  - a template's apply to draft campaigns (CT16), which writes the chosen sections as filled in
 *    for the account;
 *  - a campaign's record (CT9, `template-source.ts`), each section judged against the saved
 *    versions the record names, filled in for the account now;
 *  - the soft phone's untagged outcomes (CT11, {@link softphoneTemplateOutcomes}), read live at
 *    each call: the outcomes of the account's default chain.
 *
 * The chain (CT2, CT10): the template named, else the account's default, else the organisation's
 * default, else none (the built-in settings). An account template follows the organisation
 * template it is based on, else the organisation's default as it is now; an organisation template
 * follows nothing. The domain's `resolveTemplateSections` applies the chain section by section with
 * the built-in settings (`builtinTemplateSections()`, the one object the console reads too) and the
 * account's capabilities: recording from the account's `allow_recording` (the source the create
 * path's behavioral gate reads), the assignment and inbound sections from their flags.
 *
 * The server's notes after it (the domain never raises these):
 *  - `analysis_profile_unavailable`: the call summary profile is no longer one this account may use
 *    (gone, inactive, another account's, the account's analysis off: `preflightAnalysisProfile`,
 *    the create path's own check), or the account cannot summarise calls (`analyze_calls`, the
 *    behavioral gate's other column): it fills in as none;
 *  - `carrier_unavailable` (CT15): an account template's carrier account is not an active
 *    credential of this tenant on that carrier any more: the numbers section is built-in;
 *  - `numbers_unavailable` (CT15): caller IDs the account cannot dial from now on that carrier
 *    account are dropped and named: on a tenant credential the numbers synced to it and available
 *    to the account (`findCredentialNumbersForAccount`, the rule the create path and the dial
 *    apply); on the service's own account the account's available numbers on no credential
 *    (`findAvailableForAccount`, what the console's caller-ID list offers).
 * The create path still judges the carrier and the numbers as it does today (`carrierRejected`);
 * these notes only keep the form from opening on something it would refuse.
 */
import {
  builtinTemplateSections,
  configOfSections,
  followedBy,
  resolveTemplateSections,
  type ResolvedTemplateSections,
  type TemplateCapabilities,
  type TemplateSectionsInput,
} from '@magick-agency/domain/campaign-templates';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateNote,
  AgencyCampaignTemplateRef,
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyCampaignTemplateRepository,
  type CampaignTemplateReader,
  type CampaignTemplateRecord,
} from '../../db/repositories/agency.repository.js';
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { resolveBehavioralSettings } from '../campaign-behavioral-settings.js';
import { preflightAnalysisProfile } from '../../analysis/profile-preflight.js';
import { UUID_RE } from '../../utils/uuid.js';

const log = createChildLogger({ component: 'campaign-templates' });

/** The account a fill-in is for: a campaign always belongs to one. */
export interface TemplateAccountScope {
  tenantId: string;
  accountId: string;
}

/** A template as `template_source` and the effective read name it: its ref and its scope. */
export type TemplateRefWithScope = AgencyCampaignTemplateRef & { scope: AgencyCampaignTemplateScope };

/** The chain a fill-in reads: the template chosen (null: built-in) and the organisation template it follows. */
export interface TemplateChain {
  chosen: CampaignTemplateRecord | null;
  /** Read only for an account template: its based-on, else the organisation's default. */
  basedOn: CampaignTemplateRecord | null;
}

export type TemplateChainResult =
  | { ok: true; chain: TemplateChain }
  | { ok: false; reason: 'not_found' | 'archived' };

/**
 * `agency_campaign_templates_enabled` for a tenant and (when given) an account (CT17): every
 * template route, the create's fill-in (CT8) and the soft phone's follow (CT11). A flag read that
 * throws propagates (fails closed).
 */
export function campaignTemplatesEnabled(tenantId: string, accountId: string | null | undefined): Promise<boolean> {
  return getFeatureFlagService().isEnabled(FLAGS.agency_campaign_templates_enabled, {
    tenantId,
    ...(accountId ? { accountId } : {}),
  });
}

/** A template's scope, from its row. */
export function templateScopeOf(row: Pick<CampaignTemplateRecord, 'account_id'>): AgencyCampaignTemplateScope {
  return row.account_id === null ? 'organisation' : 'account';
}

/** A template's ref with its scope. */
export function templateRefOf(row: CampaignTemplateRecord): TemplateRefWithScope {
  return { id: row.id, name: row.name, version: row.version, scope: templateScopeOf(row) };
}

/** A template's ref. */
export function plainTemplateRefOf(row: CampaignTemplateRecord): AgencyCampaignTemplateRef {
  return { id: row.id, name: row.name, version: row.version };
}

/**
 * The chain for an account (module note). `templateId` names a template the account can see (its
 * own or the organisation's): not one, or another account's or tenant's, is `not_found`; an
 * archived one `archived`. Absent (`undefined`): the default chain. `null`: no template, the
 * built-in settings alone (New campaign's "Built-in settings", sent as `template_id: null`). A
 * string must be a UUID (the caller validates it at the edge).
 */
export async function resolveTemplateChain(
  scope: TemplateAccountScope,
  templateId?: string | null,
): Promise<TemplateChainResult> {
  const reader: CampaignTemplateReader = { tenantId: scope.tenantId, accountId: scope.accountId };
  let chosen: CampaignTemplateRecord | null;
  if (templateId === null) {
    chosen = null;
  } else if (templateId !== undefined) {
    chosen = await agencyCampaignTemplateRepository.findVisible(reader, templateId);
    if (!chosen) return { ok: false, reason: 'not_found' };
    if (chosen.archived_at !== null) return { ok: false, reason: 'archived' };
  } else {
    chosen = await agencyCampaignTemplateRepository.findDefault(reader)
      ?? await agencyCampaignTemplateRepository.findDefault({ tenantId: scope.tenantId, accountId: null });
  }
  return { ok: true, chain: { chosen, basedOn: await followedTemplate(reader, chosen) } };
}

/**
 * The organisation template an account template follows (CT10): its based-on (even one archived
 * since, a race's leftover: the account template still names it), else the organisation's
 * default as it is now. Null for an organisation template and for none.
 */
export async function followedTemplate(
  reader: CampaignTemplateReader,
  template: Pick<CampaignTemplateRecord, 'account_id' | 'based_on_template_id'> | null,
): Promise<CampaignTemplateRecord | null> {
  if (!template || template.account_id === null) return null;
  if (template.based_on_template_id) {
    const basedOn = await agencyCampaignTemplateRepository.findVisible(reader, template.based_on_template_id);
    if (basedOn) return basedOn;
  }
  return agencyCampaignTemplateRepository.findDefault({ tenantId: reader.tenantId, accountId: null });
}

/** What the account may have (CT5), and whether it may summarise calls (the profile's note). */
export interface TemplateAccountCapabilities extends TemplateCapabilities {
  analyze: boolean;
}

/**
 * The account's capabilities: `allow_recording` and `analyze_calls` as the create path's behavioral
 * gate reads them (`resolveBehavioralSettings`; a failed read is "no", failing closed as that gate
 * does), and the contact-assignment and inbound flags. A flag read that throws propagates.
 */
export async function templateCapabilities(scope: TemplateAccountScope): Promise<TemplateAccountCapabilities> {
  const flags = getFeatureFlagService();
  const context = { tenantId: scope.tenantId, accountId: scope.accountId };
  const [behavioral, assignment, inbound] = await Promise.all([
    resolveBehavioralSettings(scope).catch((err: unknown) => {
      log.error({ err }, 'account settings resolve failed in a template fill-in: recording and summaries off');
      return null;
    }),
    flags.isEnabled(FLAGS.agency_contact_assignment_enabled, context),
    flags.isEnabled(FLAGS.agency_inbound_enabled, context),
  ]);
  return {
    record: behavioral?.allow_recording === true,
    analyze: behavioral?.analyze_calls === true,
    assignment,
    inbound,
  };
}

/** The settings a new campaign of the account starts from, filled in (module note). */
export interface EffectiveTemplate {
  /** The wire answer of `GET /campaign-templates/effective`. */
  wire: AgencyCampaignTemplateEffective;
  /** The domain's answer with the server's notes applied: `config` and `sections` are what a campaign gets. */
  resolved: ResolvedTemplateSections;
  chain: TemplateChain;
}

/** The server's notes (module note), applied in place to a copy of the domain's answer. */
async function withServerNotes(
  scope: TemplateAccountScope,
  resolved: ResolvedTemplateSections,
  can: TemplateAccountCapabilities,
): Promise<ResolvedTemplateSections> {
  const sections = structuredClone(resolved.sections);
  const sources = { ...resolved.sources };
  const notes: AgencyCampaignTemplateNote[] = [...resolved.notes];

  const profileId = sections.recording.analysis_profile_id;
  if (profileId) {
    // A malformed id (a template saved before the route checked it) is unusable, never a `22P02`.
    const refused = !can.analyze || !UUID_RE.test(profileId)
      || await preflightAnalysisProfile(profileId, scope.tenantId, scope.accountId, 'agency') !== null;
    if (refused) {
      sections.recording.analysis_profile_id = null;
      notes.push({ code: 'analysis_profile_unavailable', section: 'recording' });
    }
  }

  // Only numbers an account template set (it names at least one): the built-in pool is empty.
  if (sources.numbers === 'account') {
    const numbers = sections.numbers;
    const credentialId = numbers.telephony_credential_id;
    let carrierGone = false;
    if (credentialId) {
      const credential = await telephonyCredentialRepository.findById(credentialId);
      carrierGone = !credential || credential.tenant_id !== scope.tenantId
        || credential.provider !== numbers.telephony_provider || credential.status !== 'active';
    }
    if (carrierGone) {
      sections.numbers = structuredClone(builtinTemplateSections().numbers);
      sources.numbers = 'builtin';
      notes.push({ code: 'carrier_unavailable', section: 'numbers' });
    } else {
      const usable = new Set(credentialId
        ? await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(
          scope.tenantId, scope.accountId, credentialId, numbers.caller_ids)
        : (await tenantPhoneAssignmentRepository.findAvailableForAccount(scope.tenantId, scope.accountId))
          .filter((n) => n.telephony_credential_id === null)
          .map((n) => n.phone_number));
      const dropped = numbers.caller_ids.filter((n) => !usable.has(n));
      if (dropped.length > 0) {
        numbers.caller_ids = numbers.caller_ids.filter((n) => usable.has(n));
        notes.push({ code: 'numbers_unavailable', section: 'numbers', numbers: dropped });
      }
    }
  }

  return { config: configOfSections(sections), sections, sources, notes };
}

/**
 * A template and the organisation template it follows, filled in for the account now: the domain's
 * rules for what the account may have, then the server's notes (module note). `chosen` null: the
 * built-in settings alone; `basedOn` is read only for an account template. For the effective read,
 * the create and apply (through {@link effectiveOfChain}) and a campaign's record (CT9,
 * `template-source.ts`, which passes the saved versions it names).
 */
export async function fillTemplateSections(
  scope: TemplateAccountScope,
  chosen: TemplateSectionsInput | null,
  basedOn: { sections: AgencyCampaignTemplateSections } | null,
): Promise<ResolvedTemplateSections> {
  const can = await templateCapabilities(scope);
  // `basedOn` is read only for an account template: the domain's `followedBy` decides.
  const domain = resolveTemplateSections({ chosen, basedOn, builtin: builtinTemplateSections(), can });
  return withServerNotes(scope, domain, can);
}

/**
 * A chain's rows as the domain's fill-in reads them: the chosen template's scope and sections, and
 * the organisation row it follows (the domain's `followedBy`: an account template's based-on, else
 * null), whose ref the effective read names. The one place a chain of rows becomes the domain's input.
 */
function chainInput(chain: TemplateChain): { chosen: TemplateSectionsInput | null; followed: CampaignTemplateRecord | null } {
  const chosen = chain.chosen ? { scope: templateScopeOf(chain.chosen), sections: chain.chosen.sections } : null;
  return { chosen, followed: followedBy(chosen, chain.basedOn) };
}

/** The effective settings of a chain already read (the apply reads its template once and pins it). */
export async function effectiveOfChain(scope: TemplateAccountScope, chain: TemplateChain): Promise<EffectiveTemplate> {
  const { chosen, followed } = chainInput(chain);
  const resolved = await fillTemplateSections(scope, chosen, followed ? { sections: followed.sections } : null);
  return {
    wire: {
      template: chain.chosen ? templateRefOf(chain.chosen) : null,
      based_on: followed ? plainTemplateRefOf(followed) : null,
      config: resolved.config,
      sources: resolved.sources,
      notes: resolved.notes,
    },
    resolved,
    chain,
  };
}

/**
 * The settings a new campaign of the account starts from (module note): the chain for
 * `templateId` (else the default chain), filled in for what the account may have, with the
 * server's notes. Refused as {@link resolveTemplateChain} refuses.
 */
export async function resolveEffectiveTemplate(
  scope: TemplateAccountScope,
  templateId?: string | null,
): Promise<{ ok: true; effective: EffectiveTemplate } | { ok: false; reason: 'not_found' | 'archived' }> {
  const found = await resolveTemplateChain(scope, templateId);
  if (!found.ok) return found;
  return { ok: true, effective: await effectiveOfChain(scope, found.chain) };
}

/** What untagged soft-phone calls follow when the soft phone sets no outcomes of its own (CT11). */
export interface SoftphoneTemplateOutcomes {
  /** The account's default template (else the organisation's), or null: the built-in outcomes. */
  template: TemplateRefWithScope | null;
  /**
   * The chain's outcome catalog as filled in for an account without contact assignment (no agent
   * overrides: a soft-phone call has no roster contact to grant one); `[]` (a template's empty
   * list) reads as built-in at the call (CT1). The soft phone's own catalog rules are applied by
   * its caller (`untagged-outcomes.ts`).
   */
  catalog: AgencyDisposition[];
}

/**
 * What a soft-phone call may have, fixed rather than read (CT11, CT20): no contact assignment (a
 * soft-phone call has no roster contact to grant an agent override), and nothing of recording or
 * inbound, which the outcomes section does not read.
 */
const SOFTPHONE_CAPABILITIES: TemplateCapabilities = { record: false, assignment: false, inbound: false };

/**
 * CT11: the outcomes of the account's default chain, read live (the soft phone is an account
 * setting, not a campaign, so nothing is copied), or null while `agency_campaign_templates_enabled`
 * is off for the account (the built-in outcomes, as before). The same chain ({@link chainInput})
 * and the same domain rule as a new campaign's, ON PURPOSE without {@link fillTemplateSections}:
 * the capabilities are {@link SOFTPHONE_CAPABILITIES}, not the account's (the outcomes section is
 * gated by nothing but contact assignment, which a soft-phone call never has), and the server's
 * notes, which touch only the profile and the numbers, are not read for a catalog. A flag or
 * template read that throws propagates.
 */
export async function softphoneTemplateOutcomes(scope: TemplateAccountScope): Promise<SoftphoneTemplateOutcomes | null> {
  if (!(await campaignTemplatesEnabled(scope.tenantId, scope.accountId))) return null;
  const found = await resolveTemplateChain(scope);
  if (!found.ok) return null;
  const { chosen, followed } = chainInput(found.chain);
  const resolved = resolveTemplateSections({
    chosen,
    basedOn: followed ? { sections: followed.sections } : null,
    builtin: builtinTemplateSections(),
    can: SOFTPHONE_CAPABILITIES,
  });
  return {
    template: found.chain.chosen ? templateRefOf(found.chain.chosen) : null,
    catalog: resolved.config.disposition_catalog as AgencyDisposition[],
  };
}
