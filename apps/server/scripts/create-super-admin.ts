/**
 * Create a super-admin — the only way the first one exists (decision #6: super
 * admins are created fresh, master's rows are not copied; no seeded credentials).
 *
 * NEW (magick-agency, no source). Master seeded its first admin in migration 007
 * with a known password; agency's baseline seeds none, so a fresh database has no
 * one who can log in to `/super-admin` until this runs. Every later admin is
 * created from the console (`POST /super-admin/admins`), which this mirrors:
 * the same body schema (`createSuperAdminSchema`), the same bcrypt cost (10), the
 * same "email already registered" refusal, and a `super_admin_audit_log` row.
 *
 * Usage (DATABASE_URL in the environment; the password is NEVER an argument, so
 * it stays out of shell history and `ps`):
 *
 *   SUPER_ADMIN_PASSWORD='…' pnpm tsx scripts/create-super-admin.ts --email ops@example.com --name "Ops"
 *   echo '…' | pnpm tsx scripts/create-super-admin.ts --email ops@example.com --name "Ops"
 *
 * `--system` marks the admin `is_system` (cannot be removed, reactivated or have
 * its password reset by another admin), the protection master's seeded admin had.
 *
 * In the production image it is bundled to `dist/create-super-admin.js`:
 *
 *   docker compose -f docker/docker-compose.prod.yml exec -e SUPER_ADMIN_PASSWORD='…' server \
 *     node dist/create-super-admin.js --email ops@example.com --name "Ops"
 *
 * The connection uses the server's Postgres settings (`NODE_ENV`, `DB_SSL_CA`,
 * `DB_SSL_REJECT_UNAUTHORIZED`, through `dbTlsOptions`), so it reaches a TLS-only
 * production database exactly as the server does; only the base config block is read,
 * so it needs no Firebase or carrier settings.
 */
import bcrypt from 'bcryptjs';
import { initDbPool, closePool } from '@magick-agency/db';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';
import type { SafeSuperAdminRecord } from '@magick-agency/db/models/super-admin.model';
import { getPool } from '@magick-agency/db';
import { createSuperAdminSchema } from '../src/api/validators/super-admin.validator.js';
import { baseConfigSchema, readBaseEnv } from '../src/config/blocks/base.js';
import { dbTlsOptions } from '../src/db-tls.js';
import type { Env } from '../src/config/env.js';

/** master `super-admin.routes.ts` `BCRYPT_ROUNDS`. */
const BCRYPT_ROUNDS = 10;

export interface CreateSuperAdminArgs {
  email: string;
  name: string;
  password: string;
  system?: boolean;
}

export type CreateSuperAdminResult =
  | { ok: true; admin: SafeSuperAdminRecord }
  | { ok: false; error: string };

/** Validate, refuse a duplicate, hash, insert, audit. Never logs the password. */
export async function createSuperAdmin(args: CreateSuperAdminArgs): Promise<CreateSuperAdminResult> {
  const parsed = createSuperAdminSchema.safeParse({ email: args.email, password: args.password, name: args.name });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const { email, password, name } = parsed.data;

  if (await superAdminRepository.findByEmail(email)) {
    return { ok: false, error: 'Email already registered as super admin' };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let admin = await superAdminRepository.create({ email, password_hash: passwordHash, name });
  if (args.system) {
    const { rows } = await getPool().query<SafeSuperAdminRecord>(
      `UPDATE super_admins SET is_system = true, updated_at = NOW() WHERE id = $1
       RETURNING id, email, name, status, is_system, created_at, updated_at`,
      [admin.id],
    );
    admin = rows[0]!;
  }

  // Attributed to the new admin itself: there is no acting admin on a CLI run,
  // and `admin_id` must name a `super_admins` row.
  await superAdminAuditRepository.log({
    admin_id: admin.id,
    admin_email: admin.email,
    action: 'create_admin',
    resource_type: 'super_admin',
    resource_id: admin.id,
    details: { email, name, via: 'cli', is_system: admin.is_system },
  });

  return { ok: true, admin };
}

export function parseArgs(argv: string[]): { email?: string; name?: string; system: boolean } {
  const out: { email?: string; name?: string; system: boolean } = { system: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') out.email = argv[++i];
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--system') out.system = true;
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  const { email, name, system } = parseArgs(process.argv.slice(2));
  if (!process.env['DATABASE_URL'] || !email || !name) {
    console.error('usage: SUPER_ADMIN_PASSWORD=… create-super-admin --email <email> --name <name> [--system]  (DATABASE_URL required)');
    return 2;
  }
  // The server's own validation of DATABASE_URL and the TLS settings (refuses TLS
  // parameters in the URL), and the server's TLS decision.
  const base = baseConfigSchema.pick({ server: true, db: true }).safeParse(readBaseEnv(process.env as Env));
  if (!base.success) {
    for (const issue of base.error.issues) console.error(`Invalid config: ${issue.path.join('.')}: ${issue.message}`);
    return 2;
  }
  const password = process.env['SUPER_ADMIN_PASSWORD'] ?? (await readStdin());

  initDbPool({ url: base.data.db.url, poolMin: 0, poolMax: 2, ...dbTlsOptions(base.data) });
  try {
    const result = await createSuperAdmin({ email, name, password, system });
    if (!result.ok) {
      console.error(`refused: ${result.error}`);
      return 1;
    }
    console.log(`created super admin ${result.admin.email} (${result.admin.id})${result.admin.is_system ? ' [system]' : ''}`);
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1]?.endsWith('create-super-admin.ts') || process.argv[1]?.endsWith('create-super-admin.js')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
