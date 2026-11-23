// Real Postgres: migrations/0067_campaign_templates.sql (docs/campaign-templates.md §4; wire shapes in
// packages/contracts/src/api/agency/campaign-templates.ts). globalSetup has applied every migration.
// Pins both tables' columns, the sections and based-on CHECKs both ways, the one-live-default-per-scope
// index (the organisation scope, whose account_id is NULL, included; an archived default not counted),
// the versions' key and cascade, agency_campaigns.template_source, the lock timeout on Up and Down,
// then down and up again.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertCampaign, insertRow } from '../fixtures.js';

const pool = () => getTestPool();
const FILE = '0067_campaign_templates.sql';

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

/** A valid live account template of ACCOUNT, not a default. */
function template(o: Record<string, unknown> = {}) {
  return insertRow('agency_campaign_templates', { tenant_id: TENANT, account_id: ACCOUNT, name: `T ${randomUUID()}`, ...o });
}
const organisationTemplate = (o: Record<string, unknown> = {}) => template({ account_id: null, ...o });

const refused = (constraint: string) => ({ code: '23514', constraint });
const duplicateDefault = { code: '23505', constraint: 'uq_agency_campaign_templates_default' };

async function columns(table: string) {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; len: number | null }>(
    `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length AS len FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows.map((r) => `${r.column_name} ${r.data_type}${r.len ? `(${r.len})` : ''}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`);
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

function statements(file: string, part: 'up' | 'down'): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const body = part === 'up'
    ? text.split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!
    : text.split(/^-- Down Migration/m)[1]!;
  return body.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('0067 — campaign templates', () => {
  it('Up and Down start with the lock timeout (ADD COLUMN locks agency_campaigns, which the server writes)', () => {
    expect(statements(FILE, 'up')[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements(FILE, 'down')[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it('the templates table as §4 declares it, and a template takes its defaults', async () => {
    expect(await columns('agency_campaign_templates')).toEqual([
      'id uuid not null default gen_random_uuid()',
      'tenant_id uuid not null',
      'account_id uuid',
      'name character varying(80) not null',
      'description character varying(280)',
      'based_on_template_id uuid',
      "sections jsonb not null default '{}'::jsonb",
      'is_default boolean not null default false',
      'version integer not null default 1',
      'created_by uuid',
      'updated_by uuid',
      'created_at timestamp with time zone not null default now()',
      'updated_at timestamp with time zone not null default now()',
      'archived_at timestamp with time zone',
      'archived_by uuid',
    ]);
    expect(await template()).toMatchObject({ sections: {}, is_default: false, version: 1, archived_at: null, based_on_template_id: null });
  });

  it('the versions table: one row per (template, version), deleted with its template', async () => {
    expect(await columns('agency_campaign_template_versions')).toEqual([
      'template_id uuid not null',
      'version integer not null',
      'name character varying(80) not null',
      'based_on_template_id uuid',
      'sections jsonb not null',
      'saved_by uuid',
      'saved_at timestamp with time zone not null default now()',
    ]);
    const t = await template();
    await insertRow('agency_campaign_template_versions', { template_id: t.id, version: 1, name: 'v1', sections: '{}' });
    await expect(insertRow('agency_campaign_template_versions', { template_id: t.id, version: 1, name: 'again', sections: '{}' }))
      .rejects.toMatchObject({ code: '23505' });
    await expect(insertRow('agency_campaign_template_versions', { template_id: randomUUID(), version: 1, name: 'x', sections: '{}' }))
      .rejects.toMatchObject({ code: '23503' });
    await pool().query('DELETE FROM agency_campaign_templates WHERE id = $1', [t.id]);
    const { rows } = await pool().query('SELECT 1 FROM agency_campaign_template_versions');
    expect(rows).toEqual([]);
  });

  it('sections must be a JSON object', async () => {
    await template({ sections: JSON.stringify({ hours: { calling_window_start: '09:00:00' } }) });
    for (const bad of ['[]', '"hours"', '1', 'null']) {
      await expect(template({ sections: bad })).rejects.toMatchObject(refused('ck_agency_campaign_templates_sections'));
    }
  });

  it('an organisation template cannot be based on another; an account template can', async () => {
    const org = await organisationTemplate();
    await template({ based_on_template_id: org.id });
    await expect(organisationTemplate({ based_on_template_id: org.id })).rejects.toMatchObject(refused('ck_agency_campaign_templates_based_on'));
    await expect(template({ based_on_template_id: randomUUID() })).rejects.toMatchObject({ code: '23503' });
  });

  it('one live default per scope: the organisation scope (account_id NULL) is one scope too', async () => {
    await organisationTemplate({ is_default: true });
    await expect(organisationTemplate({ is_default: true })).rejects.toMatchObject(duplicateDefault);
    await template({ is_default: true });
    await expect(template({ is_default: true })).rejects.toMatchObject(duplicateDefault);
    // Other scopes have their own: another account, another tenant's organisation.
    await template({ account_id: randomUUID(), is_default: true });
    await organisationTemplate({ tenant_id: randomUUID(), is_default: true });
    // Any number of templates that are not the default.
    await template();
    await organisationTemplate();
    expect(await indexDef('uq_agency_campaign_templates_default')).toBe(
      'CREATE UNIQUE INDEX uq_agency_campaign_templates_default ON public.agency_campaign_templates USING btree (tenant_id, account_id) NULLS NOT DISTINCT WHERE (is_default AND (archived_at IS NULL))');
  });

  it('an archived default is not counted: the scope may have a live one beside it', async () => {
    await template({ is_default: true, archived_at: new Date() });
    await template({ is_default: true });
    await organisationTemplate({ is_default: true, archived_at: new Date() });
    await organisationTemplate({ is_default: true });
    // Restoring the archived one while it still says default would make two: refused.
    await expect(pool().query('UPDATE agency_campaign_templates SET archived_at = NULL WHERE archived_at IS NOT NULL'))
      .rejects.toMatchObject(duplicateDefault);
  });

  it('the scope index, as defined', async () => {
    expect(await indexDef('idx_agency_campaign_templates_scope')).toBe(
      'CREATE INDEX idx_agency_campaign_templates_scope ON public.agency_campaign_templates USING btree (tenant_id, account_id) WHERE (archived_at IS NULL)');
  });

  it('agency_campaigns.template_source: nullable JSONB with no default, NULL on a campaign made without one', async () => {
    const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'agency_campaigns' AND column_name = 'template_source'`);
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
    expect(await insertCampaign()).toMatchObject({ template_source: null });
  });

  it('down drops both tables and the column; up re-applies', async () => {
    const t = await template({ is_default: true });
    await insertRow('agency_campaign_template_versions', { template_id: t.id, version: 1, name: 'v1', sections: '{}' });
    await insertCampaign({ template_source: JSON.stringify({ template: null, based_on: null, sections: {} }) });
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const { rows } = await pool().query(
        `SELECT tablename FROM pg_tables WHERE tablename IN ('agency_campaign_templates', 'agency_campaign_template_versions')`);
      expect(rows).toEqual([]);
      const { rows: col } = await pool().query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_campaigns' AND column_name = 'template_source'`);
      expect(col).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect((await columns('agency_campaign_templates')).length).toBe(15);
    expect(await indexDef('uq_agency_campaign_templates_default')).toBeDefined();
  });
});
