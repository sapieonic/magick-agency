import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/**
 * That posthog-js still honours `ph-no-capture`, in the version this repo pins.
 *
 * ── Why a test at all, rather than a line in a docstring ───────────────────
 * `AgencyJoinPage` marks its invitation card with that class, and everything
 * inside it is somebody else's personal data — the invitee's address, the
 * inviter's name, the workspace's name — on a page where `autocapture`,
 * `rageclick` and `capture_dead_clicks` are all on. The class is the reason none
 * of that is read off the DOM and sent, so the page's PII posture rests on the
 * behaviour of a dependency rather than on any code in this repo. An upgrade that
 * renamed or dropped it would leak silently: nothing here would fail, and the
 * events would simply start carrying names.
 *
 * ── What is checked, and why it is the bundle rather than a click ──────────
 * The honest test would be to init posthog-js and dispatch a click. It cannot be
 * written here: autocapture only attaches after remote config arrives, which
 * means a network round trip this suite must not make, and stubbing it deeply
 * enough to be meaningful would be a test of the stub. What CAN be pinned without
 * pretending is that the shipped build still carries the mechanism — the class
 * name, and the `explicitNoCapture` decision it feeds, which is what makes the
 * autocapture handler return before sending anything and reduces a dead click's
 * properties to an empty bag.
 *
 * So this is a canary on the dependency, not a proof of the browser's behaviour.
 * When it reds, the answer is to re-read posthog-js's autocapture source and
 * decide whether the page still opts out — not to soften the assertion. The
 * fallback if it ever stops being true is already in place and asserted properly:
 * `analytics/redact.ts`'s `stripJoinPageElements` removes the element payload
 * from any capture on that route at the `before_send` boundary.
 *
 * BOTH entry points are read. Vite resolves `module` and the Node-side tooling
 * `main`, and a build that carried the mechanism in one and not the other would
 * be a difference between what the tests exercise and what ships.
 */
describe('posthog-js still honours ph-no-capture', () => {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('posthog-js/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    version: string;
    main?: string;
    module?: string;
  };
  const packageRoot = dirname(manifestPath);

  const entries = (['main', 'module'] as const)
    .map((field) => ({ field, file: manifest[field] }))
    .filter((entry): entry is { field: 'main' | 'module'; file: string } => Boolean(entry.file));

  it('declares both entry points, so neither can be checked by accident', () => {
    expect(entries.map((e) => e.field)).toEqual(['main', 'module']);
  });

  it.each(entries)('$field carries the opt-out class and its effect', ({ file }) => {
    const bundle = readFileSync(resolve(packageRoot, file), 'utf-8');

    // The class the page marks its card with.
    expect(bundle).toContain('ph-no-capture');
    // …and what finding it in the clicked element's ancestor chain does: the
    // autocapture properties are abandoned rather than merely trimmed.
    expect(bundle).toContain('explicitNoCapture');
  });

  it('is the version the lockfile pins, so this says something about what ships', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
