/**
 * `AgencyCampaignTemplateRepository`: campaign templates and their versions
 * (`agency_campaign_templates`, `agency_campaign_template_versions`, 0067; docs/campaign-templates.md
 * §4, rulings CT6, CT10, CT13, CT14). The wire shapes are `packages/contracts/src/api/agency/campaign-templates.ts`;
 * the routes map these records onto them and resolve the actors' names.
 *
 * ── Scopes ──────────────────────────────────────────────────────────────────
 * A template's scope is its tenant and its account, `accountId: null` for an organisation
 * template. READS take the reader's context ({@link CampaignTemplateReader}): an account reader sees
 * its account's templates and the organisation's; a reader with no account sees the organisation's
 * only. Another tenant's or another account's template is not found, the same answer as a template
 * that does not exist. WRITES take the template's exact scope ({@link CampaignTemplateScope}): the
 * route has read the template, decided the caller may write that scope (CT3), and names it; a row
 * of another scope is not found.
 *
 * ── What this file owns, in transactions ────────────────────────────────────
 *  - **Versions (CT6).** Every content save bumps `version` and writes the version row in the same
 *    transaction; a save names the version it read and is refused (`changed`, with the current
 *    version) when another save came between. The row is locked `FOR UPDATE` before the check.
 *  - **Names (CT13).** Unique among the scope's LIVE templates by `nameKey` (case and repeated
 *    spaces folded, the account-name rule). Not an index (the rule folds), so every write that can
 *    add a live name (create, replace, restore) takes the SCOPE's transaction advisory lock first:
 *    two creates of "Collections" at once serialise and the second sees the first (as AA3 locks the
 *    tenant row for account names).
 *  - **Defaults.** One live default per scope (`uq_agency_campaign_templates_default` backs it):
 *    making one clears the old one in the same transaction, under the scope lock.
 *  - **Based on (CT10, CT14).** An account template may name a LIVE organisation template of its
 *    tenant. The write reads that row `FOR SHARE`, and archive locks the organisation template
 *    `FOR UPDATE` before it counts the live account templates based on it: so an archive and a
 *    create naming it serialise, and either the create sees it archived or the archive sees the new
 *    account template and is refused (`in_use`). Archiving clears the default; restoring re-checks
 *    the name and the based-on.
 *
 * **Lock order**: the scope's advisory lock, then the template's row, then the based-on row, in every
 * transaction here that takes more than one of them. `clearDefault` takes the template's row alone:
 * it adds no live name and no default, so it needs no scope lock, and holding one lock it cannot
 * close a cycle (a `setDefault` or create clearing the same row waits for it, then sees it cleared).
 * Each refusal is a typed result, never a throw.
 *
 * `updated_at` / `updated_by` move with the content (create, replace) only: a default or archive
 * change is not an edit of the template.
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { PoolClient } from 'pg';
import {
  AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX,
  type AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { nameKey } from '../../../utils/name-key.js';

/** One stored template (`agency_campaign_templates`). `account_id` null: an organisation template. */
export interface CampaignTemplateRecord {
  id: string;
  tenant_id: string;
  account_id: string | null;
  name: string;
  description: string | null;
  based_on_template_id: string | null;
  sections: AgencyCampaignTemplateSections;
  is_default: boolean;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  archived_by: string | null;
}

/** One saved state (`agency_campaign_template_versions`). */
export interface CampaignTemplateVersionRecord {
  template_id: string;
  version: number;
  name: string;
  based_on_template_id: string | null;
  sections: AgencyCampaignTemplateSections;
  saved_by: string | null;
  saved_at: Date;
}

/**
 * One row of a template's history, without its sections: `section_keys` are the keys its sections
 * set, read in SQL (`jsonb_object_keys`), so a page of history never carries the sections to Node.
 */
export interface CampaignTemplateVersionSummaryRecord extends Omit<CampaignTemplateVersionRecord, 'sections'> {
  section_keys: string[];
}

/** A template's exact scope: `accountId: null` is the tenant's organisation templates. */
export interface CampaignTemplateScope {
  tenantId: string;
  accountId: string | null;
}

/** Who reads: the request's tenant and context account (`null`: no account context, organisation templates only). */
export type CampaignTemplateReader = CampaignTemplateScope;

/** A template named by id, name and version. */
export interface CampaignTemplateRef {
  id: string;
  name: string;
  version: number;
}

/** A live account template based on an organisation template (CT14's `in_use`). */
export interface CampaignTemplateBasedOnRow {
  id: string;
  name: string;
  account_id: string;
}

/** A template's content: everything a create or a replace writes. Validated by the route first. */
export interface CampaignTemplateContent {
  name: string;
  description: string | null;
  /** Account templates only; must name a live organisation template of the tenant. */
  based_on_template_id: string | null;
  sections: AgencyCampaignTemplateSections;
}

/** Why a based-on cannot be used: none of the tenant's organisation templates has the id, or it is archived. */
type BasedOnRefusal = { ok: false; reason: 'based_on_not_found' } | { ok: false; reason: 'based_on_archived' };
type NameRefusal = { ok: false; reason: 'name_taken'; template: { id: string; name: string } };
/** The scope already keeps `AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX` live templates (a create or a restore would add one). */
type LimitRefusal = { ok: false; reason: 'limit_reached'; limit: number };

export type CampaignTemplateCreateResult =
  | { ok: true; template: CampaignTemplateRecord; replaced: CampaignTemplateRef | null }
  | NameRefusal
  | LimitRefusal
  | BasedOnRefusal;

export type CampaignTemplateReplaceResult =
  | { ok: true; template: CampaignTemplateRecord }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'archived' }
  | { ok: false; reason: 'changed'; current_version: number }
  | NameRefusal
  | BasedOnRefusal;

/**
 * `changed`, on a default, archive or restore: whether this call changed the template (made it the
 * default, archived it, …), decided under the row's lock, so two calls at once see one change and
 * the routes audit it once.
 */
export type CampaignTemplateDefaultResult =
  | { ok: true; template: CampaignTemplateRecord; replaced: CampaignTemplateRef | null; changed: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'archived' };

export type CampaignTemplateClearDefaultResult =
  | { ok: true; template: CampaignTemplateRecord; changed: boolean }
  | { ok: false; reason: 'not_found' };

export type CampaignTemplateArchiveResult =
  | { ok: true; template: CampaignTemplateRecord; default_cleared: boolean; changed: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; templates: CampaignTemplateBasedOnRow[] };

export type CampaignTemplateRestoreResult =
  | { ok: true; template: CampaignTemplateRecord; changed: boolean }
  | { ok: false; reason: 'not_found' }
  | NameRefusal
  | LimitRefusal
  | BasedOnRefusal;

const COLUMNS = `id, tenant_id, account_id, name, description, based_on_template_id, sections, is_default, version,
       created_by, updated_by, created_at, updated_at, archived_at, archived_by`;

/** The reader's visible set: the tenant's organisation templates and, with an account, that account's. $1 tenant, $2 account or NULL (`findVersion` repeats it on its join). */
const VISIBLE_SQL = `tenant_id = $1::uuid AND (account_id IS NULL OR account_id = $2::uuid)`;

/** The exact scope: $1 tenant, $2 account or NULL (the organisation). */
const IN_SCOPE_SQL = `tenant_id = $1::uuid AND account_id IS NOT DISTINCT FROM $2::uuid`;

/**
 * The scope's write lock (name uniqueness, the default): a transaction advisory lock keyed by the
 * tenant and the account, or `organisation`. Taken first in every write that needs it.
 */
const CAMPAIGN_TEMPLATE_SCOPE_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtextextended('agency_campaign_templates:scope:' || $1::text || ':' || COALESCE($2::text, 'organisation'), 0))`;

/**
 * The list's statement ({@link AgencyCampaignTemplateRepository.list}): $1 tenant, $2 account or NULL.
 * The archive predicate is written out in the indexes' own words, so the planner proves its
 * partial index applies (0067's live index, 0068's archived one); exported for the plan test.
 */
export function campaignTemplateListSql(archived: boolean): string {
  return `SELECT ${COLUMNS} FROM agency_campaign_templates
        WHERE ${VISIBLE_SQL} AND ${archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'}
        ORDER BY (account_id IS NULL), is_default DESC, lower(name), id`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function lockScope(client: PoolClient, scope: CampaignTemplateScope): Promise<void> {
  await client.query(CAMPAIGN_TEMPLATE_SCOPE_LOCK_SQL, [scope.tenantId, scope.accountId]);
}

/**
 * The scope's live template whose name is `name` by {@link nameKey}, but `exceptId`; with `adding`
 * (a create or a restore: one more live template), also the scope's cap
 * (`AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX`, which bounds this read). Under the scope lock.
 */
async function nameClash(
  client: PoolClient,
  scope: CampaignTemplateScope,
  name: string,
  exceptId: string | null,
  adding = false,
): Promise<NameRefusal | LimitRefusal | null> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM agency_campaign_templates
      WHERE ${IN_SCOPE_SQL} AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [scope.tenantId, scope.accountId, exceptId],
  );
  const key = nameKey(name);
  const clash = rows.find((r) => nameKey(r.name) === key);
  if (clash) return { ok: false, reason: 'name_taken', template: { id: clash.id, name: clash.name } };
  if (adding && rows.length >= AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX) {
    return { ok: false, reason: 'limit_reached', limit: AGENCY_CAMPAIGN_TEMPLATE_LIVE_MAX };
  }
  return null;
}

/**
 * The based-on, read `FOR SHARE` so an archive of it waits for this write (module note): a live
 * organisation template of the tenant, else why not. Null id: nothing to check.
 */
async function basedOnRefused(client: PoolClient, tenantId: string, basedOnId: string | null): Promise<BasedOnRefusal | null> {
  if (basedOnId === null) return null;
  const { rows } = await client.query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM agency_campaign_templates
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id IS NULL
      FOR SHARE`,
    [basedOnId, tenantId],
  );
  if (rows.length === 0) return { ok: false, reason: 'based_on_not_found' };
  return rows[0]!.archived_at === null ? null : { ok: false, reason: 'based_on_archived' };
}

/** The template's row in its exact scope, locked `FOR UPDATE`, or null. */
async function lockRow(client: PoolClient, scope: CampaignTemplateScope, id: string): Promise<CampaignTemplateRecord | null> {
  const { rows } = await client.query<CampaignTemplateRecord>(
    `SELECT ${COLUMNS} FROM agency_campaign_templates WHERE id = $3::uuid AND ${IN_SCOPE_SQL} FOR UPDATE`,
    [scope.tenantId, scope.accountId, id],
  );
  return rows[0] ?? null;
}

/** Clear the scope's live default but `keepId`, returning the one cleared. Under the scope lock. */
async function clearScopeDefault(client: PoolClient, scope: CampaignTemplateScope, keepId: string | null): Promise<CampaignTemplateRef | null> {
  const { rows } = await client.query<CampaignTemplateRef>(
    `UPDATE agency_campaign_templates SET is_default = false
      WHERE ${IN_SCOPE_SQL} AND is_default AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)
      RETURNING id, name, version`,
    [scope.tenantId, scope.accountId, keepId],
  );
  return rows[0] ?? null;
}

async function writeVersion(client: PoolClient, t: CampaignTemplateRecord, savedBy: string | null): Promise<void> {
  await client.query(
    `INSERT INTO agency_campaign_template_versions (template_id, version, name, based_on_template_id, sections, saved_by, saved_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::uuid, $7)`,
    [t.id, t.version, t.name, t.based_on_template_id, json(t.sections), savedBy, t.updated_at],
  );
}

export class AgencyCampaignTemplateRepository {
  /**
   * The reader's templates (module note: an account's and the organisation's), live ones or, with
   * `archived`, archived ones. The account's first, then the organisation's; each scope's default
   * first, then by name, the id last so the order is total ({@link campaignTemplateListSql}).
   */
  async list(reader: CampaignTemplateReader, options: { archived?: boolean } = {}): Promise<CampaignTemplateRecord[]> {
    const { rows } = await getPool().query<CampaignTemplateRecord>(
      campaignTemplateListSql(options.archived === true),
      [reader.tenantId, reader.accountId],
    );
    return rows;
  }

  /** One template the reader may see, live or archived, else null (another tenant's or account's included). */
  async findVisible(reader: CampaignTemplateReader, id: string): Promise<CampaignTemplateRecord | null> {
    const { rows } = await getPool().query<CampaignTemplateRecord>(
      `SELECT ${COLUMNS} FROM agency_campaign_templates WHERE id = $3::uuid AND ${VISIBLE_SQL}`,
      [reader.tenantId, reader.accountId, id],
    );
    return rows[0] ?? null;
  }

  /**
   * The templates of `ids` the reader may see, live or archived, in one read (an id it may not see
   * is absent): the based-on templates a list names that the list itself does not hold.
   */
  async findManyVisible(reader: CampaignTemplateReader, ids: readonly string[]): Promise<CampaignTemplateRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await getPool().query<CampaignTemplateRecord>(
      `SELECT ${COLUMNS} FROM agency_campaign_templates WHERE id = ANY($3::uuid[]) AND ${VISIBLE_SQL}`,
      [reader.tenantId, reader.accountId, [...ids]],
    );
    return rows;
  }

  /** The scope's live default template, else null (`accountId: null`: the organisation's). */
  async findDefault(scope: CampaignTemplateScope): Promise<CampaignTemplateRecord | null> {
    const { rows } = await getPool().query<CampaignTemplateRecord>(
      `SELECT ${COLUMNS} FROM agency_campaign_templates WHERE ${IN_SCOPE_SQL} AND is_default AND archived_at IS NULL`,
      [scope.tenantId, scope.accountId],
    );
    return rows[0] ?? null;
  }

  /**
   * The live account templates of the tenant based on organisation template `templateId`, by name
   * (CT14: an archive is refused naming them; the effective read follows them). A template of an
   * account marked deleted is not counted: no screen reaches that account to rebase it, so it must
   * not hold the organisation template live (the account name rule excludes them the same way).
   */
  async findLiveBasedOn(tenantId: string, templateId: string, client?: PoolClient): Promise<CampaignTemplateBasedOnRow[]> {
    const { rows } = await (client ?? getPool()).query<CampaignTemplateBasedOnRow>(
      `SELECT t.id, t.name, t.account_id FROM agency_campaign_templates t
        WHERE t.tenant_id = $1::uuid AND t.based_on_template_id = $2::uuid AND t.account_id IS NOT NULL
          AND t.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.status = 'deleted')
        ORDER BY lower(t.name), t.id`,
      [tenantId, templateId],
    );
    return rows;
  }

  /**
   * Create a template in `scope` at version 1, with its version row. `makeDefault` makes it the
   * scope's default, clearing the old one (`replaced`). Refused when a live template of the scope
   * has the name, or the based-on is not a live organisation template of the tenant.
   */
  async create(
    scope: CampaignTemplateScope,
    content: CampaignTemplateContent,
    options: { actorUserId: string | null; makeDefault?: boolean },
  ): Promise<CampaignTemplateCreateResult> {
    return withTransaction(async (client) => {
      await lockScope(client, scope);
      const clash = await nameClash(client, scope, content.name, null, true);
      if (clash) return clash;
      const basedOn = await basedOnRefused(client, scope.tenantId, content.based_on_template_id);
      if (basedOn) return basedOn;
      const replaced = options.makeDefault ? await clearScopeDefault(client, scope, null) : null;
      const { rows } = await client.query<CampaignTemplateRecord>(
        `INSERT INTO agency_campaign_templates
           (tenant_id, account_id, name, description, based_on_template_id, sections, is_default, created_by, updated_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb, $7, $8::uuid, $8::uuid)
         RETURNING ${COLUMNS}`,
        [
          scope.tenantId, scope.accountId, content.name, content.description, content.based_on_template_id,
          json(content.sections), options.makeDefault === true, options.actorUserId,
        ],
      );
      const template = rows[0]!;
      await writeVersion(client, template, options.actorUserId);
      return { ok: true, template, replaced } as const;
    }, { pool: getPool() });
  }

  /**
   * Replace a live template's content whole, as version `expectedVersion + 1` (CT6), with its
   * version row. Refused: not in `scope`, archived, `changed` (another save came first), the name
   * taken in the scope, or the based-on not usable. Scope, default and archive state are kept.
   */
  async replace(
    scope: CampaignTemplateScope,
    id: string,
    content: CampaignTemplateContent & { expected_version: number },
    options: { actorUserId: string | null },
  ): Promise<CampaignTemplateReplaceResult> {
    return withTransaction(async (client) => {
      await lockScope(client, scope);
      const row = await lockRow(client, scope, id);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.archived_at !== null) return { ok: false, reason: 'archived' } as const;
      if (row.version !== content.expected_version) return { ok: false, reason: 'changed', current_version: row.version } as const;
      // Not `adding`: a replace keeps the count, so only a name can clash.
      const clash = await nameClash(client, scope, content.name, id) as NameRefusal | null;
      if (clash) return clash;
      const basedOn = await basedOnRefused(client, scope.tenantId, content.based_on_template_id);
      if (basedOn) return basedOn;
      const { rows } = await client.query<CampaignTemplateRecord>(
        `UPDATE agency_campaign_templates
            SET name = $2, description = $3, based_on_template_id = $4::uuid, sections = $5::jsonb,
                version = version + 1, updated_by = $6::uuid, updated_at = now()
          WHERE id = $1::uuid
          RETURNING ${COLUMNS}`,
        [id, content.name, content.description, content.based_on_template_id, json(content.sections), options.actorUserId],
      );
      const template = rows[0]!;
      await writeVersion(client, template, options.actorUserId);
      return { ok: true, template } as const;
    }, { pool: getPool() });
  }

  /** Make a live template its scope's default, clearing the old one in the same transaction (`replaced`; null when it already was). */
  async setDefault(scope: CampaignTemplateScope, id: string): Promise<CampaignTemplateDefaultResult> {
    return withTransaction(async (client) => {
      await lockScope(client, scope);
      const row = await lockRow(client, scope, id);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.archived_at !== null) return { ok: false, reason: 'archived' } as const;
      const replaced = await clearScopeDefault(client, scope, id);
      const { rows } = await client.query<CampaignTemplateRecord>(
        `UPDATE agency_campaign_templates SET is_default = true WHERE id = $1::uuid RETURNING ${COLUMNS}`,
        [id],
      );
      return { ok: true, template: rows[0]!, replaced, changed: !row.is_default } as const;
    }, { pool: getPool() });
  }

  /** The scope has no default: this template is not one (already not one is fine: `changed` false). */
  async clearDefault(scope: CampaignTemplateScope, id: string): Promise<CampaignTemplateClearDefaultResult> {
    return withTransaction(async (client) => {
      const row = await lockRow(client, scope, id);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (!row.is_default) return { ok: true, template: row, changed: false } as const;
      const { rows } = await client.query<CampaignTemplateRecord>(
        `UPDATE agency_campaign_templates SET is_default = false WHERE id = $1::uuid RETURNING ${COLUMNS}`,
        [id],
      );
      return { ok: true, template: rows[0]!, changed: true } as const;
    }, { pool: getPool() });
  }

  /**
   * Archive a template (CT14): kept with its versions, no longer a default (`default_cleared`).
   * An organisation template that live account templates are based on is refused, naming them.
   * Archiving an archived template changes nothing.
   */
  async archive(scope: CampaignTemplateScope, id: string, options: { actorUserId: string | null }): Promise<CampaignTemplateArchiveResult> {
    return withTransaction(async (client) => {
      await lockScope(client, scope);
      const row = await lockRow(client, scope, id);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.archived_at !== null) return { ok: true, template: row, default_cleared: false, changed: false } as const;
      // After the row lock: an account template's create or replace naming it holds it FOR SHARE
      // until commit, so every one committed before this is counted here.
      if (scope.accountId === null) {
        const using = await this.findLiveBasedOn(scope.tenantId, id, client);
        if (using.length > 0) return { ok: false, reason: 'in_use', templates: using } as const;
      }
      const { rows } = await client.query<CampaignTemplateRecord>(
        `UPDATE agency_campaign_templates
            SET archived_at = now(), archived_by = $2::uuid, is_default = false
          WHERE id = $1::uuid
          RETURNING ${COLUMNS}`,
        [id, options.actorUserId],
      );
      return { ok: true, template: rows[0]!, default_cleared: row.is_default, changed: true } as const;
    }, { pool: getPool() });
  }

  /**
   * Restore an archived template: live again, not a default. Its name is checked again against the
   * scope's live templates, and an account template's based-on must still be live. Restoring a
   * live template changes nothing.
   */
  async restore(scope: CampaignTemplateScope, id: string): Promise<CampaignTemplateRestoreResult> {
    return withTransaction(async (client) => {
      await lockScope(client, scope);
      const row = await lockRow(client, scope, id);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.archived_at === null) return { ok: true, template: row, changed: false } as const;
      const clash = await nameClash(client, scope, row.name, id, true);
      if (clash) return clash;
      const basedOn = await basedOnRefused(client, scope.tenantId, row.based_on_template_id);
      if (basedOn) return basedOn;
      const { rows } = await client.query<CampaignTemplateRecord>(
        `UPDATE agency_campaign_templates SET archived_at = NULL, archived_by = NULL, is_default = false
          WHERE id = $1::uuid
          RETURNING ${COLUMNS}`,
        [id],
      );
      return { ok: true, template: rows[0]!, changed: true } as const;
    }, { pool: getPool() });
  }

  /**
   * A page of a visible template's saved states, newest first: at most `page.limit`, older than
   * `page.before` when given. Each row's section keys are read in SQL, never its sections (each up
   * to 256 KiB). Null when the reader cannot see the template.
   */
  async listVersions(
    reader: CampaignTemplateReader,
    id: string,
    page: { before?: number | null; limit: number },
  ): Promise<CampaignTemplateVersionSummaryRecord[] | null> {
    if (!(await this.findVisible(reader, id))) return null;
    const { rows } = await getPool().query<CampaignTemplateVersionSummaryRecord>(
      `SELECT template_id, version, name, based_on_template_id,
              ARRAY(SELECT jsonb_object_keys(sections)) AS section_keys, saved_by, saved_at
         FROM agency_campaign_template_versions
        WHERE template_id = $1::uuid AND ($2::int IS NULL OR version < $2::int)
        ORDER BY version DESC
        LIMIT $3`,
      [id, page.before ?? null, page.limit],
    );
    return rows;
  }

  /** One saved state of a visible template, else null. */
  async findVersion(reader: CampaignTemplateReader, id: string, version: number): Promise<CampaignTemplateVersionRecord | null> {
    const { rows } = await getPool().query<CampaignTemplateVersionRecord>(
      `SELECT v.template_id, v.version, v.name, v.based_on_template_id, v.sections, v.saved_by, v.saved_at
         FROM agency_campaign_template_versions v
         JOIN agency_campaign_templates t ON t.id = v.template_id
        WHERE v.template_id = $3::uuid AND v.version = $4
          AND t.tenant_id = $1::uuid AND (t.account_id IS NULL OR t.account_id = $2::uuid)`,
      [reader.tenantId, reader.accountId, id, version],
    );
    return rows[0] ?? null;
  }
}

export const agencyCampaignTemplateRepository = new AgencyCampaignTemplateRepository();
