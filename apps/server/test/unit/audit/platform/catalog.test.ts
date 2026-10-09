import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_RESOURCE_TYPES,
} from '../../../../src/audit/platform/catalog.js';
import { PERMISSION_MATRIX } from '@magick-agency/contracts/rbac';

/*
 * The action / resource-type scrape covers EVERY file under `src/`, taking the
 * literals inside each `platformAuditLogger.log({` block (the 20-line window the
 * call-site guard uses). It cannot be confused by the voice engine's
 * `auditLogger.log` (audit_logs) or the super-admin audit writer.
 *
 * The audit.read floor is checked against the contracts' matrix
 * (`@magick-agency/contracts/rbac`).
 *
 * The "D10: concurrency is super-admin only" source guards read
 * `proxy-agency-campaigns.routes.ts`, `agency/agency-campaign-config.ts` and
 * `super-admin.routes.ts` (ROOT is `apps/server`). `concurrency-super-admin-only.test.ts`
 * also carries broadened copies of the first two (every agency route/module) and a
 * copy of the third; this is the original single-file form, including the positive
 * `D10: there is no concurrency setter` comment check on the route file.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AUDIT_LOG_CALL = 'platformAuditLogger.log({';
const CALL_SITE_WINDOW = 20;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** The text of every `platformAuditLogger.log({` block under `src/`. */
function auditWriteBlocks(): string[] {
  const blocks: string[] = [];
  for (const file of walk(resolve(ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(AUDIT_LOG_CALL)) blocks.push(lines.slice(index, index + CALL_SITE_WINDOW).join('\n'));
    });
  }
  return blocks;
}

describe('PLATFORM_AUDIT_ACTIONS', () => {
  it('covers every action: string written through auditLogger.log', () => {
    const found = new Set<string>();
    for (const src of auditWriteBlocks()) {
      for (const match of src.matchAll(/action:\s*'([a-z0-9_.]+)'/g)) {
        found.add(match[1]!);
      }
    }
    const missing = [...found].filter((action) => !(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action));
    expect(missing, `actions written but not in the catalog: ${missing.join(', ')}`).toEqual([]);
  });

  it('resource types used on those writes are in PLATFORM_AUDIT_RESOURCE_TYPES', () => {
    const found = new Set<string>();
    for (const src of auditWriteBlocks()) {
      for (const match of src.matchAll(/resource_type:\s*'([a-z0-9_]+)'/g)) {
        found.add(match[1]!);
      }
    }
    const missing = [...found].filter(
      (type) => !(PLATFORM_AUDIT_RESOURCE_TYPES as readonly string[]).includes(type),
    );
    expect(missing).toEqual([]);
  });

  it('pins audit.read at account_admin — the floor the console must mirror', () => {
    expect(PERMISSION_MATRIX['audit.read']).toBe('account_admin');
  });
});

describe('D10: concurrency is super-admin only', () => {
  it('the agency campaign proxy has no concurrency write path', () => {
    const source = readFileSync(resolve(ROOT, 'src/api/routes/proxy-agency-campaigns.routes.ts'), 'utf8');
    expect(source).toMatch(/D10: there is no concurrency setter/);
    expect(source).not.toMatch(/app\.(put|post|patch)(?:<[^>]*>)?\([^)]*concurrency/);
    // Payload field, not just the URL: a concurrency setter must not land as an unaudited
    // campaign body key. The D10 comment names `max_concurrent_calls`; a setter
    // would have to mention it as a schema key, not only in that comment.
    expect(source).not.toMatch(/max_concurrent_calls:\s/);
  });

  it('agency campaign config validation has no concurrency field', () => {
    const source = readFileSync(resolve(ROOT, 'src/agency/agency-campaign-config.ts'), 'utf8');
    expect(source).not.toMatch(/max_concurrent|concurrency/);
  });

  it('super-admin account concurrency already writes super_admin_audit', () => {
    const source = readFileSync(resolve(ROOT, 'src/api/routes/super-admin.routes.ts'), 'utf8');
    expect(source).toMatch(/action: 'update_account_concurrency'/);
    expect(source).toMatch(/superAdminAuditRepository\.log/);
  });
});
