import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * **Every audited write must DERIVE its actor, not assert one (`86d45t7rm`).**
 *
 * ── What the type system already guarantees, and where it stops ─────────────
 * `actor_type` is a required field of `CreateAuditLogInput`, so `tsc --noEmit`
 * (which is what `npm run lint` is) fails on a call site that states no actor at
 * all. That is what made this repair platform-wide rather than another special
 * case, and it is genuinely strong: the four bad object literals are rejected
 * too (`test/unit/db/repositories/audit.repository.test.ts`).
 *
 * It cannot force a call site to state the RIGHT actor. This compiles:
 *
 *     auditLogger.log({ ..., actor_type: 'human', user_id: request.user!.id })
 *
 * and for a creator-backed key it is bit-for-bit the defect this ticket exists
 * to remove — `sessionMiddleware` loads `platform_api_keys.created_by` into
 * `request.user`, so the key's minter is recorded as though they had acted.
 * Verified rather than assumed: reinstating exactly that at two call sites in
 * `schedule.routes.ts` left `tsc --noEmit` completely clean.
 *
 * ── Why a SOURCE guard, and why this repo in particular ────────────────────
 * The behavioural tests next door pin the routes they cover, but they pin the
 * call sites that EXIST. The failure this guards is a call site added later —
 * and the misattribution has now been introduced independently four times in
 * this codebase (`resolveAgencyActor`, the agency `my-*` surfaces,
 * `resolveTransitionActor`, and the audit rows themselves), each time by someone
 * reaching for `request.user` because it was right there and populated. A guard
 * that fails on the SHAPE is the only thing that reaches a call site nobody has
 * written yet.
 *
 * The repo already uses this pattern for the same class of problem —
 * `test/unit/auth/api-key-route-blocks.test.ts` — and CLAUDE.md names it as one
 * of "the two guards that keep this from regressing". The comment stripper below
 * is that file's, for the reason its docstring gives at length: this codebase
 * documents holes by quoting the old code, so a raw-text assertion fails on the
 * explanation and the tempting "fix" is to delete the explanation.
 */

/*
 * PORT NOTE (magick-agency): ported from master
 * test/unit/audit/audit-actor-call-sites.test.ts@a1f0756a. Changes:
 *  - the guarded call is `platformAuditLogger.log({` — master's logger's name in
 *    this app (`src/audit/platform/audit-logger.ts`). The bare
 *    `auditLogger.log({` here is CORE's `audit_logs` writer, whose events carry a
 *    free-form `actor` string and none of this union, so scanning for it would
 *    flag every ported core call site;
 *  - "finds the audited call sites at all" (master: ≥ 29) was deleted in Phase 2b
 *    (nothing ported yet) and is RESTORED by lane A with floor 4 — see the case;
 *  - MODIFIED: "confines SYSTEM_AUDIT_ACTOR to background writers" expects no
 *    file: master's two (`scheduling/retry.manager.ts`,
 *    `scheduling/scheduler.service.ts`) are AI scheduling and are not ported;
 *  - the rest, including the comment stripper and its three tests, is verbatim.
 */
const AUDIT_LOG_CALL = 'platformAuditLogger.log({';

/**
 * The sanctioned ways to state an actor.
 *
 * Two derive it from the request (`src/audit/audit-actor.ts`); `SYSTEM_AUDIT_ACTOR`
 * is the named constant for a write with no caller; and `...input.actor` / `...actor`
 * is a service receiving one from its route, which the behavioural tests then
 * pin at the route (`test/unit/api/routes/schedule-routes-audit-actor.test.ts`).
 *
 * Deliberately NOT on this list: a bare `actor_type:` literal. That is the whole
 * point — it is what compiles while being wrong.
 */
const SANCTIONED = [
  '...requestAuditActor(request)',
  '...resolvedUserAuditActor(request',
  '...SYSTEM_AUDIT_ACTOR',
  '...input.actor',
  '...actor,',
];

/** How far past the opening line to look for the actor spread. */
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

/** See `api-key-route-blocks.test.ts` — a single state-machine pass, not two regexes. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
      state = 'code';
    }
    out += c; i += 1; continue;
  }
  return out;
}

interface CallSite { file: string; line: number; block: string }

function auditCallSites(): CallSite[] {
  const root = resolve(process.cwd(), 'src');
  const sites: CallSite[] = [];

  for (const file of walk(root)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (!line.includes(AUDIT_LOG_CALL)) return;
      sites.push({
        file: file.slice(root.length + 1),
        line: index + 1,
        block: lines.slice(index, index + CALL_SITE_WINDOW).join('\n'),
      });
    });
  }
  return sites;
}

describe('every auditLogger.log call site derives its actor (86d45t7rm)', () => {
  const sites = auditCallSites();

  /*
   * RESTORED by lane A (magick-agency). Master: `>= 29` over its whole tree
   * (`grep -rn "auditLogger.log({" src` at a1f0756a: 33 matches — 32 live call
   * sites plus one in an `audit-actor.ts` comment, which the stripper drops). Of
   * master's 32: 4 are lane A's routes, ported here (`invites.routes.ts` 2,
   * `user.routes.ts` 2); 18 are lane B2's agency routes (`dnc` 2,
   * `proxy-agency-agent` 8, `proxy-agency-campaigns` 6, `proxy-agency-staffing` 2),
   * not yet ported; 10 are the AI scheduler's (`scheduling/*`), never ported. So
   * the floor was lane A's 4; the agency routes raise it to 22 as they land.
   * The canary's job is unchanged: a refactor that renames the call (so the scan
   * finds nothing and every assertion below passes vacuously) fails here.
   *
   * Phase 8 (magick-agency): 22 — lane A's 4 plus the agency routes, each at master's
   * count (`dnc.routes.ts` 2, `proxy-agency-campaigns.routes.ts` 6,
   * `proxy-agency-staffing.routes.ts` 2, `proxy-agency-agent.routes.ts` 8).
   */
  it('finds the audited call sites at all', () => {
    expect(sites.length).toBeGreaterThanOrEqual(22);
  });

  it('states an actor through a sanctioned derivation at every site', () => {
    const offenders = sites
      .filter((site) => !SANCTIONED.some((form) => site.block.includes(form)))
      .map((site) => `${site.file}:${site.line}`);

    expect(offenders, [
      'An audited write must derive its actor, never assert one.',
      'Use requestAuditActor(request) on a request-scoped write, SYSTEM_AUDIT_ACTOR',
      'on a background one, or thread an AuditActorFields down from the route.',
      'Writing `actor_type: \'human\', user_id: request.user.id` compiles and is the',
      'defect 86d45t7rm removed: a creator-backed API key carries request.user, so',
      'that records the person who minted the credential as though they acted.',
    ].join(' ')).toEqual([]);
  });

  /**
   * `system` is the strongest claim on the enum — "no principal existed" rather
   * than "I could not work out who" — so the places entitled to make it stay
   * countable. Anything request-scoped must derive instead; the ambiguity this
   * ticket names in core's `last_transition_by` is exactly what a `system` used
   * as a fallback would recreate here.
   */
  it('confines SYSTEM_AUDIT_ACTOR to background writers', () => {
    const systemSites = sites
      .filter((site) => site.block.includes('...SYSTEM_AUDIT_ACTOR'))
      .map((site) => site.file);

    expect([...new Set(systemSites)].sort()).toEqual([]);
  });

  /**
   * No route may claim a background write. A request always has a principal to
   * name — even "a credential we cannot identify" is `api_key`, not `system`.
   */
  it('never lets a route claim a system actor', () => {
    const offenders = sites
      .filter((site) => site.file.startsWith('api/routes/'))
      .filter((site) => site.block.includes('...SYSTEM_AUDIT_ACTOR'))
      .map((site) => `${site.file}:${site.line}`);

    expect(offenders).toEqual([]);
  });
});

describe('the comment stripper itself', () => {
  /**
   * Load-bearing for every assertion above: a stripper that swallows live code
   * turns this file into a rubber stamp. The specific false-pass vector is a
   * `/*` inside a `//` comment opening a phantom block comment — this repo
   * writes globs like `src/api/routes/` + a star + `.ts` in comments constantly.
   */
  it('does not let a glob inside a line comment swallow the next lines', () => {
    const src = [
      '// glob: src/api/routes/*.ts',
      'auditLogger.log({',
      '// rate is calls*/minute',
    ].join('\n');

    expect(stripComments(src)).toContain('auditLogger.log({');
  });

  it('keeps line numbering honest across a block comment', () => {
    const src = ['a;', '/* one', 'two */', 'b;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(4);
  });

  it('leaves a comment delimiter inside a string alone', () => {
    expect(stripComments('const s = "a // b";')).toContain('a // b');
  });
});
