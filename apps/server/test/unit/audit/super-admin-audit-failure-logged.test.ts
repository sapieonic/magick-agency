import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * NEW (magick-agency), Manas 2026-10-09: super-admin audit writes stay fire-and-forget
 * (master's behaviour) but a failed write is logged at ERROR with the action, actor and
 * target instead of vanishing into master's `.catch(() => {})`. Mutation-checked: replacing
 * the helper's `onError` body with nothing reds cases 1 and 2.
 */
const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  repoLog: vi.fn(),
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.repoLog },
}));

import { recordSuperAdminAudit } from '../../../src/audit/super-admin-audit.js';

const ENTRY = {
  admin_id: 'sa-1', admin_email: 'root@example.com',
  action: 'revoke_membership', resource_type: 'membership', resource_id: 'm-1',
  details: { tenant_id: 't-1', user_id: 'u-1' },
};

const EXPECTED_CONTEXT = {
  action: 'revoke_membership',
  actor: { admin_id: 'sa-1', admin_email: 'root@example.com' },
  target: { resource_type: 'membership', resource_id: 'm-1' },
  tenantId: 't-1',
};

describe('recordSuperAdminAudit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a rejected write is logged at ERROR with action, actor and target, and never rejects', async () => {
    const err = new Error('insert failed');
    mocks.repoLog.mockRejectedValue(err);
    await expect(recordSuperAdminAudit(ENTRY)).resolves.toBeUndefined();
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ err, ...EXPECTED_CONTEXT }), expect.stringContaining('NOT recorded'));
  });

  it('a synchronous throw (no pool) is logged the same way', async () => {
    mocks.repoLog.mockImplementation(() => { throw new Error('Database pool not initialized'); });
    await expect(recordSuperAdminAudit(ENTRY)).resolves.toBeUndefined();
    expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining(EXPECTED_CONTEXT), expect.any(String));
  });

  it('writes the entry unchanged, in the same tick, and logs nothing on success', async () => {
    mocks.repoLog.mockResolvedValue(undefined);
    const pending = recordSuperAdminAudit(ENTRY);
    expect(mocks.repoLog).toHaveBeenCalledWith(ENTRY);
    await pending;
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it('no route swallows a super-admin audit failure silently any more', () => {
    const dir = resolve(__dirname, '../../../src/api/routes');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      expect(source, file).not.toMatch(/superAdminAuditRepository\.log\([\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
    }
  });
});
