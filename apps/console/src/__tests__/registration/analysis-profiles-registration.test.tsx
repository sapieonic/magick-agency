import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * Registration contracts intentionally inspect the private route/navigation
 * declarations. These data structures are not exported, and exporting them
 * solely for tests would expand the production API surface.
 */
/*
 * The three cases are pinned to agency's gates — the `agency.analytics`
 * capability (the active account's `analyze_calls`) and the `agency_call_analysis`
 * flag.
 */
describe('dialer call-analysis registration', () => {
  it('protects the Call Summaries route with its Settings entry’s gate (the capability and flag below)', () => {
    const app = source('../../App.tsx');

    expect(app).toMatch(
      /path="call-summaries"\s+element=\{<RequireGate\s+gate=\{settingsEntry\('call-summaries'\)\.gate\}>\s*<AnalysisProfilesPage\s*\/>\s*<\/RequireGate>\}/s,
    );
  });

  it('requires both gates before Call summaries appears in the Settings hub and GlobalSearch', () => {
    const nav = source('../../utils/consoleNav.ts');
    const search = source('../../utils/consoleSearch.ts');

    expect(nav).toMatch(
      /label:\s*'Call summaries'[\s\S]*?flags:\s*\[CALL_ANALYSIS_FLAG\][\s\S]*?capabilities:\s*\['agency\.analytics'\]/,
    );
    expect(nav).toContain("export const CALL_ANALYSIS_FLAG = 'agency_call_analysis';");
    // Search keeps no gates of its own for Settings (B28): it offers the hub's entries under
    // the hub's gates, so the two above are the ones ⌘K applies too.
    expect(search).toMatch(/SETTINGS_ENTRIES\.filter\(\(entry\) => passesGate\(entry\.gate, gate\)\)/);
  });

  it('registers the analytics capability in the RequireCapability union and tracking gate set', () => {
    const guard = source('../../components/auth/RequireCapability.tsx');

    expect(guard).toMatch(/type KnownCapabilityGate\s*=\s*[\s\S]*?\| 'agency\.analytics'/);
    expect(guard).toMatch(/KNOWN_CAPABILITY_GATES[\s\S]*?'agency\.analytics'/);
  });
});
