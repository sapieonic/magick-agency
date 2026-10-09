import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `<WorkspaceExit/>` is the only `/app` link agency code may contain (§7b).
 *
 * ── The bug this is the guard for ──────────────────────────────────────────
 * The agency workspace (`AgencyLayout`, everything under `/agency`, `/dialer` and
 * `/station`) and the primary AI application (`AppLayout`, everything under
 * `/app`) are separate shells, and §7b makes that a boundary rather than a
 * coincidence: *"A link that crosses shells is a bug even when the data it lands
 * on is correct, because it strands the reader outside the context they were
 * working in."* The concrete leak was call-shaped deep links — a row in a
 * campaign's attempts list pointing at `/app/calls/dialer/history/:id`. Follow
 * one and the campaign you were reading is gone, the destination is gated on
 * `calls.dialer` which most agency staff do not hold, and the levels below
 * `viewer` land in a shell whose sidebar renders empty.
 *
 * ── Why this is a source-scanning test and not a rendering one ─────────────
 * The previous attempt at this boundary was enforced by a comment asking
 * reviewers to watch for it, and it leaked — §7b: *"Prose does not hold a
 * boundary."* A behavioural test cannot replace it either: every one of these
 * links renders perfectly and navigates successfully, so there is no assertion to
 * make at the DOM about a link that is wrong for a reason no renderer can see.
 * That puts this in the same category as `hiddenPanelCss.test.ts` — assert the
 * wiring in the source, because the defect is invisible from inside a test
 * renderer. The mechanism is deliberately dumb: give the string `/app` exactly
 * one legal home in agency code, then fail the build when it appears anywhere
 * else.
 *
 * ── What is NOT a violation ────────────────────────────────────────────────
 * §7b names three zones, not two, and the third is the one that gets misread.
 * Team and membership (including inviting agents), credits, billing and invoices,
 * the tenant audit log, API keys, settings, onboarding, and tenant/account
 * switching are **platform** surfaces, shared by both products by design. They
 * live at `/app`; linking to them from the agency shell is correct and must
 * survive. `AgencyLayout` holds no credits, no team and no settings on purpose,
 * because a pure-agency supervisor legitimately administers in `/app` and
 * operates in `/agency`. So this test does not remove the exits — it makes them
 * the only ones, by routing them through one component that says out loud that it
 * is an exit.
 *
 * `AgencyLayout`'s own "Team & settings" link (cusui: "Back to MagickVoice") was considered and deliberately
 * left alone: it lives in `src/components/layout/`, outside all three guarded
 * roots, because it is the shell itself rather than a page inside it. It is the
 * canonical example of a correct exit.
 *
 * ── All THREE roots, and the third is easy to miss ────────────────────────
 * `src/pages/campaigns/agency/` is agency code despite sitting under a path that
 * says `campaigns` — it is the agency campaign builder. §7b calls this out by
 * name for exactly that reason. Guarding only the two obvious roots would leave
 * the builder as a hole the size of a whole feature.
 *
 * ── Comments are stripped first, and that is load-bearing ─────────────────
 * A plain substring match over these files is useless, and worse than useless: it
 * reports around fifteen lines of comment prose that mention `/app` precisely in
 * order to document why the boundary exists and why each deliberate exit is
 * correct — in `AgentConsolePage`, `AgencyCampaignAttemptsPage`,
 * `AgencyHomeRedirect`, `AgentAttemptsPage`, `AgentHomePage`,
 * `AgencyCampaignActivityPage`, `AgencyContactDetailPage`, `AgentBucketChart`,
 * `AgentLanding` and `AgentAttemptsPanel`. A test that fires on its own
 * documentation gets deleted by the third person who hits it, and the boundary
 * goes back to being prose. So `stripComments` removes `//` line comments,
 * slash-star block comments and the brace-wrapped JSX form of the same before
 * anything is matched, and the codebase keeps the right to explain itself.
 *
 * The stripper is a small state machine rather than a regex because it must also
 * track string literals: a `//` inside `'https://…'` is not a comment, and
 * blanking the rest of that line could hide a real offender sitting after it.
 * Newlines are preserved through stripped comments so the reported line numbers
 * still point at the real source.
 */

/** `…/src`, since this file is `src/__tests__/utils/`. */
const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = dirname(srcRoot);

/**
 * Every root that is agency code, relative to `src/`.
 *
 * `pages/campaigns/agency` is not a typo and not optional — see the header.
 */
const AGENCY_ROOTS = ['pages/agency', 'components/agency', 'pages/campaigns/agency'];

/**
 * The single exemption, as a full path rather than a basename.
 *
 * A basename exemption would let anyone open a second `WorkspaceExit.tsx`
 * anywhere under the agency roots and inherit the licence, which is the one thing
 * a single-sanctioned-home rule cannot survive.
 */
const SANCTIONED_EXIT = 'src/components/agency/WorkspaceExit.tsx';

/**
 * `/app` as a route literal, not as a prefix of some longer word.
 *
 * The negative lookahead is what separates `/app`, `/app/`, `/app"`, `` /app` ``
 * and `/app?tab=x` from `/apps`, `/appointments` and `/app-store`. It is applied
 * to comment-stripped source, so what is left is code: string literals, template
 * literals and JSX attribute values — everywhere a route can actually be spelled.
 */
const APP_ROUTE_LITERAL = /\/app(?![\w-])/;

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Remove comments, keep code, keep line numbering.
 *
 * String literals are tracked so a `//` or a `/*` inside one is left intact;
 * escapes are consumed in pairs so `'\\'` does not read as an unterminated
 * string. Regex literals and division are not modelled — a `//` cannot appear in
 * either, so the only cost is a hypothetical `/…/` regex that opens with `*`,
 * which no source here contains.
 */
function stripComments(source: string): string {
  let out = '';
  let mode: Mode = 'code';
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const pair = source.slice(i, i + 2);

    if (mode === 'code') {
      if (pair === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (pair === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (pair === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      // Kept so a stripped block comment does not shift the lines beneath it.
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }

    // Inside a string literal of some kind.
    if (ch === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (ch === closer) mode = 'code';
    out += ch;
    i += 1;
  }

  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

/** `path:line` for every `/app` route literal left after comments are stripped. */
function appRouteLiterals(): string[] {
  return AGENCY_ROOTS.flatMap((root) => walk(join(srcRoot, root))).flatMap((path) => {
    const rel = relative(repoRoot, path);
    if (rel === SANCTIONED_EXIT) return [];
    return stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .flatMap((line, index) => (APP_ROUTE_LITERAL.test(line) ? [`${rel}:${index + 1}`] : []));
  });
}

/*
 * There was a baseline here, holding the two "Open call" links on attempt rows
 * that pointed at the AI product's `calls.dialer`-gated call history. It was
 * written to shrink and it has: both now point at
 * `/agency/campaigns/:id/attempts/:attemptId`, the agency's own call detail, and
 * the exemption is gone with them.
 *
 * There is no baseline any more, and there should not be another one. The guard
 * below is now absolute: exactly one file under the agency roots may name `/app`.
 */

describe('agency shell boundary', () => {
  it('routes every /app link in agency code through WorkspaceExit', () => {
    expect(appRouteLiterals()).toEqual([]);
  });

  it('ignores /app mentioned in comment prose', () => {
    // Around fifteen comment lines under these roots mention `/app` while
    // documenting the boundary itself. If the stripper regressed, the first test
    // would fire on the documentation and get deleted — so assert the stripper
    // directly, on the shape those comments actually take.
    const jsdoc = ['/**', ' * a plain `/app` would resolve it', ' */', 'const x = 1;'].join('\n');
    const jsx = ['{/* every route back (`/app`, `/`) returns here */}', '<div />'].join('\n');
    const line = '// every `/app/*` path an agent could reach';

    expect(APP_ROUTE_LITERAL.test(stripComments(jsdoc))).toBe(false);
    expect(APP_ROUTE_LITERAL.test(stripComments(jsx))).toBe(false);
    expect(APP_ROUTE_LITERAL.test(stripComments(line))).toBe(false);

    // And still sees code, including a `//` that is a URL rather than a comment.
    expect(APP_ROUTE_LITERAL.test(stripComments('<Link to="/app/calls" />'))).toBe(true);
    expect(APP_ROUTE_LITERAL.test(stripComments('const u = "https://x"; to("/app/y");'))).toBe(true);
    // A longer word starting with `app` is not a route literal.
    expect(APP_ROUTE_LITERAL.test(stripComments('to("/appointments")'))).toBe(false);
  });
});
