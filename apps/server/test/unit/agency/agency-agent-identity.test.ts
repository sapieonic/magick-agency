import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { foldHighestRole } from '../../../src/agency/agency-agent-identity.js';

/**
 * The pure half of the campaign-staffing identity read.
 *
 * `userRepository.findIdentitiesInTenant` deliberately returns one row PER
 * MEMBERSHIP rather than one per person — a user can hold an account-scoped
 * membership per account plus a tenant-level one — and leaves the choice of which
 * role to report to this function, where `ROLE_HIERARCHY` lives. Getting that
 * choice wrong is silent: the list still renders, it just shows a supervisor an
 * "agent" who can in fact start and stop campaigns.
 */

const USER = 'user-1';

describe('foldHighestRole', () => {
  it('keeps the highest-authority role a person holds in the tenant', () => {
    const folded = foldHighestRole([
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'agent' },
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'tenant_admin' },
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'viewer' },
    ]);

    expect(folded.get(USER)).toEqual({
      name: 'Sam',
      email: 'sam@example.com',
      role: 'tenant_admin',
    });
  });

  it('is order-independent — the highest wins whichever row arrives first', () => {
    // Postgres makes no ordering promise for this query, so a fold that kept the
    // first row would be right in tests and wrong in production at random.
    const ascending = foldHighestRole([
      { id: USER, display_name: null, email: 'a@b.c', role: 'agent' },
      { id: USER, display_name: null, email: 'a@b.c', role: 'operator' },
    ]);
    const descending = foldHighestRole([
      { id: USER, display_name: null, email: 'a@b.c', role: 'operator' },
      { id: USER, display_name: null, email: 'a@b.c', role: 'agent' },
    ]);

    expect(ascending.get(USER)!.role).toBe('operator');
    expect(descending.get(USER)!.role).toBe('operator');
  });

  it('keeps name and email SEPARATE, never folding one into the other', () => {
    // `findDisplayNamesInTenant` folds a missing name into the email for the stats
    // poll. This surface must not: a supervisor choosing between two people called
    // "Sam" disambiguates by address.
    const folded = foldHighestRole([
      { id: USER, display_name: null, email: 'sam@example.com', role: 'agent' },
    ]);

    expect(folded.get(USER)).toEqual({ name: null, email: 'sam@example.com', role: 'agent' });
  });

  it('treats a whitespace-only display name as no name', () => {
    const folded = foldHighestRole([
      { id: USER, display_name: '   ', email: 'sam@example.com', role: 'agent' },
    ]);

    expect(folded.get(USER)!.name).toBeNull();
  });

  it('drops an unrecognised role rather than ranking it', () => {
    // A role string from a future migration this build predates has no rank.
    // Comparing against `ROLE_HIERARCHY[unknown]` (undefined) is how it would
    // silently win, so it is dropped and the known role stands.
    const folded = foldHighestRole([
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'agent' },
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'grand_poobah' },
    ]);

    expect(folded.get(USER)!.role).toBe('agent');
  });

  it('reports null when a person holds ONLY an unrecognised role', () => {
    const folded = foldHighestRole([
      { id: USER, display_name: 'Sam', email: 'sam@example.com', role: 'grand_poobah' },
    ]);

    expect(folded.get(USER)!.role).toBeNull();
  });

  it('folds several people independently', () => {
    const folded = foldHighestRole([
      { id: 'a', display_name: 'A', email: 'a@x.io', role: 'agent' },
      { id: 'b', display_name: 'B', email: 'b@x.io', role: 'tenant_owner' },
    ]);

    expect(folded.size).toBe(2);
    expect(folded.get('a')!.role).toBe('agent');
    expect(folded.get('b')!.role).toBe('tenant_owner');
  });
});

describe('resolveAgentNames is declared ONCE', () => {
  /**
   * The export exists to end a duplication, and for one release it did not: this
   * module's docstring described a consolidation while
   * `proxy-agency-campaigns.routes.ts` went on declaring a byte-identical local
   * `resolveAgentNames`, so the two call sites in that file never reached the
   * shared binding at all. Nothing could catch it — the copies behaved
   * identically, which is exactly why a behavioural test cannot express this
   * claim and a structural one has to.
   *
   * What the claim protects is not performance but AGREEMENT: the campaign
   * spine's JSON list, its CSV drain and the supervisor's view of one agent must
   * name the same person the same way, and a second lookup is how one of them
   * starts reporting an email where another reports a display name.
   */
  const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('has exactly one declaration in src/, and it is this module’s', () => {
    const declarations = tsFiles(SRC).filter((file) =>
      /\b(?:const|let|var|function)\s+resolveAgentNames\b/.test(readFileSync(file, 'utf8')),
    );

    expect(declarations.map((f) => f.slice(SRC.length + 1)))
      .toEqual(['agency/agency-agent-identity.ts']);
  });

  it('is imported by both files that enrich an agent id', () => {
    // Named rather than counted: an importer that quietly stopped importing it
    // has almost certainly re-declared one, which the case above would also catch
    // — but this is the assertion that says WHERE the shared binding is supposed
    // to be reaching.
    // Phase 8: both consumers now exist at master's paths, so the loop is master's verbatim
    // (B2 had filtered on `existsSync` and pinned the count at 0 until they landed).
    for (const consumer of [
      'api/routes/proxy-agency-campaigns.routes.ts',
      'api/routes/proxy-agency-performance.routes.ts',
    ]) {
      const source = readFileSync(join(SRC, consumer), 'utf8');
      // `[^}]*` rather than a lazy `[\s\S]*?`, which would start at an earlier
      // `import {` and run through every import in between.
      const importBlock =
        /^import\s*\{([^}]*)\}\s*from\s*'[^']*agency-agent-identity\.js';/m.exec(source);

      expect(importBlock, `${consumer} must import from agency-agent-identity`).not.toBeNull();
      expect(
        importBlock![1]!.split(',').map((n) => n.trim()),
        `${consumer} must take resolveAgentNames from the shared module`,
      ).toContain('resolveAgentNames');
    }
  });
});
