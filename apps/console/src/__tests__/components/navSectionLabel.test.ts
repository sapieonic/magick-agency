import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Decision NV1: a group label (the Settings hub's "You", "This account · …" and "People and
 * access", the campaign bar's Monitor, Data and Set up, the search's result groups) has one
 * look, set in one place, and never the look of an item. jsdom applies no stylesheet, so the
 * rules are read from the CSS itself; the render tests (SettingsHub, CampaignTabs,
 * GlobalSearch) prove the semantics.
 */

const src = resolve(__dirname, '../..');
const css = (path: string) => readFileSync(resolve(src, path), 'utf-8');

/** Every declaration block whose selector list is exactly `selector`. */
function blocks(sheet: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...sheet.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]!);
}

function first(sheet: string, selector: string): string {
  const found = blocks(sheet, selector);
  expect(found.length, `${selector} block`).toBeGreaterThan(0);
  return found[0]!;
}

const LABEL = css('components/common/NavSectionLabel.module.css');
const TAB_BAR = css('components/common/TabBar.module.css');
const CAMPAIGN = css('components/agency/CampaignTabs.module.css');
const SETTINGS = css('pages/settings/SettingsLayout.module.css');
const SEARCH = css('components/common/GlobalSearch.module.css');

/** The look the shared label owns; a host that sets any of it has forked the look. */
const LOOK = /\b(color|font-size|font-weight|letter-spacing|text-transform|line-height)\s*:/;

describe('the group label (NV1)', () => {
  it('is small, uppercase, tracked and muted, and takes no pointer or selection', () => {
    const label = first(LABEL, '.label');
    expect(label).toMatch(/color:\s*var\(--text-muted\)/);
    expect(label).toMatch(/text-transform:\s*uppercase/);
    expect(label).toMatch(/letter-spacing:\s*0\.\d+em/);
    expect(label).toMatch(/font-size:\s*11px/);
    expect(label).toMatch(/cursor:\s*default/);
    expect(label).toMatch(/user-select:\s*none/);
  });

  it('has no hover, focus or active state: nothing about it says "press me"', () => {
    expect(LABEL).not.toMatch(/:(hover|focus|focus-visible|active)\b/);
  });

  it('is styled in one place: the hosts set only their own spacing', () => {
    for (const [sheet, selector] of [
      [SETTINGS, '.groupTitle'],
      [CAMPAIGN, '.groupLabel'],
      [SEARCH, '.sectionHeader'],
    ] as const) {
      for (const block of blocks(sheet, selector)) expect(block, selector).not.toMatch(LOOK);
    }
  });
});

describe('an item beside a group label', () => {
  it('is never in the label’s muted colour, in the shared tab bar or the Settings hub', () => {
    // The campaign bar's tabs were `--text-muted`, the same grey as Monitor, Data and Set up.
    expect(first(TAB_BAR, '.tab')).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(first(SETTINGS, '.item')).toMatch(/color:\s*var\(--text-secondary\)/);
    for (const block of blocks(CAMPAIGN, '.tab')) expect(block).not.toMatch(/color:\s*var\(--text-muted\)/);
  });

  it('is the shared tab in the campaign bar, so the two tab bars cannot drift apart', () => {
    expect(first(CAMPAIGN, '.tab')).toMatch(/composes:\s*tab from '\.\.\/common\/TabBar\.module\.css'/);
    expect(first(CAMPAIGN, '.tabActive')).toMatch(/composes:\s*tabActive from '\.\.\/common\/TabBar\.module\.css'/);
  });

  it('shows it can be pressed: a hover, a keyboard ring inside its box, and the open page marked', () => {
    expect(first(TAB_BAR, '.tab:hover')).toMatch(/color:\s*var\(--text-primary\)/);
    expect(first(TAB_BAR, '.tab:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(first(SETTINGS, '.item')).toMatch(/cursor:\s*pointer/);
    expect(first(SETTINGS, '.item:hover')).toMatch(/color:\s*var\(--text-primary\)/);
    expect(first(SETTINGS, '.item:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(first(SETTINGS, '.item:focus-visible')).toMatch(/outline-offset:\s*-2px/);
  });

  it('stops animating for a reader who prefers reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(SETTINGS)?.[1] ?? '';
    expect(reduced).toMatch(/\.item\b/);
    expect(reduced).toMatch(/transition:\s*none/);
  });
});
