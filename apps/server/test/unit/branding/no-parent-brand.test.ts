import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { platformConfigSchema } from '../../../src/config/blocks/platform.js';
import {
  agencyProductName,
  renderAgentInviteEmail,
} from '../../../src/notifications/templates/agent-invite.template.js';
import { maskedErrorBody } from '../../../src/api/middleware/error-mask.middleware.js';

/**
 * The server sends nobody a MagickVoice name or link (decision B17, Manas
 * 2026-10-09: "this shouldn't have any linking present").
 *
 * NEW in Magick Agency (no master or core source). Two halves:
 *  - the surfaces a person reads — the invite mail, the claim page's product
 *    noun, the masked error body — rendered from their defaults;
 *  - a scan of every `.ts` file under `apps/server/src` and the shipped
 *    packages' `src` (contracts, db, domain, observability), comments stripped, because a CSV
 *    preamble, an error body or a log line a support engineer pastes to a
 *    customer is user-facing too, and the next one will not be in this list.
 * Comments are excluded: they carry source provenance ("master's
 * `src/...` in MagickVoice"), which is documentation, not product. The internal
 * `x-mgkvc-*` header names do not match the pattern and are out of scope.
 */

const PARENT_BRAND = /magick[\s_-]?voice|magic[\s_-]?voice/i;
const serverRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const repoRoot = dirname(dirname(serverRoot));
/**
 * The server's own `src` and the workspace packages it ships (compiled into the
 * bundle). `packages/contracts` is also compiled into both SPAs.
 */
const SCANNED_ROOTS = [
  join(serverRoot, 'src'),
  join(repoRoot, 'packages', 'contracts', 'src'),
  join(repoRoot, 'packages', 'db', 'src'),
  join(repoRoot, 'packages', 'domain', 'src'),
  join(repoRoot, 'packages', 'observability', 'src'),
];

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';

/** Remove `//` and slash-star comments, keep strings and line numbers. */
function stripComments(source: string): string {
  let out = '';
  let mode: Mode = 'code';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const pair = source.slice(i, i + 2);
    if (mode === 'code') {
      // `://` is a URL scheme, not a comment — unquoted URLs live in JSX prose,
      // CSS `url(...)` and unquoted attributes, and must stay visible.
      if (pair === '//' && (i === 0 || source[i - 1] !== ':')) { mode = 'line'; i += 2; continue; }
      if (pair === '/*') { mode = 'block'; i += 2; continue; }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (pair === '*/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (ch === closer || (ch === '\n' && mode !== 'template')) mode = 'code';
    out += ch;
    i += 1;
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    // `.ts` only: the `.json` files under `src/` are test-transcription fixtures
    // (e.g. `voicelink-carrier.fixture.json`) whose `description` names the
    // source repo, and JSON has no comment syntax to put that in.
    return entry.endsWith('.ts') ? [path] : [];
  });
}

function parentBrandMentions(): string[] {
  return SCANNED_ROOTS.flatMap((root) => walk(root)).flatMap((path) => {
    const rel = relative(repoRoot, path);
    return stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .flatMap((line, index) => (PARENT_BRAND.test(line) ? [`${rel}:${index + 1}: ${line.trim()}`] : []));
  });
}

describe('no MagickVoice branding in what the server sends (B17)', () => {
  it('names MagickVoice nowhere in src or the shipped packages, outside comments', () => {
    expect(parentBrandMentions()).toEqual([]);
  });

  it('defaults the brand to Magick Agency', () => {
    const brand = platformConfigSchema.parse({}).brand;
    expect(brand.name).toBe('Magick Agency');
    expect(agencyProductName(brand.name)).toBe('Magick Agency Dialer');
  });

  it('renders the default invite mail without the parent brand', () => {
    const mail = renderAgentInviteEmail({
      brandName: platformConfigSchema.parse({}).brand.name,
      joinUrl: 'https://console.example.com/agency/join/tok_abc',
      email: 'newagent@example.com',
      tenantName: 'Acme Collections',
      inviterName: 'Priya Sharma',
      roleLabel: 'Agent',
      expiresAt: new Date('2026-01-08T00:00:00Z'),
    });
    expect(mail.subject).toBe("You've been added to the Magick Agency Dialer");
    for (const part of [mail.subject, mail.textBody, mail.htmlBody]) {
      expect(part).not.toMatch(PARENT_BRAND);
    }
    expect(mail.textBody).toContain('Sent by Magick Agency.');
  });

  it('strips comments but sees strings and unquoted URLs', () => {
    expect(PARENT_BRAND.test(stripComments('// ported from MagickVoice\nconst x = 1;'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments('/** master: MagickVoice */\nconst x = 1;'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments('const x = 1; // see https://magickvoice.com'))).toBe(false);
    expect(PARENT_BRAND.test(stripComments("const s = 'Sent by MagickVoice';"))).toBe(true);
    // `//` after a scheme is a URL, not a comment.
    expect(PARENT_BRAND.test(stripComments('<p>Visit https://docs.magickvoice.com for help</p>'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('.x { background: url(https://cdn.magickvoice.com/a.png) }'))).toBe(true);
    expect(PARENT_BRAND.test(stripComments('<a href=https://magickvoice.com>'))).toBe(true);
  });

  it('masks errors without a support address', () => {
    for (const status of [400, 500]) {
      const { message } = maskedErrorBody('req-1', status);
      expect(message).toContain('contact support and quote the request ID');
      expect(message).not.toMatch(/@/);
    }
  });
});
