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
  it('protects the Call Summaries route with the analytics capability and feature flag', () => {
    const app = source('../../App.tsx');

    expect(app).toMatch(
      /path="call-summaries"\s+element=\{<RequireCapability\s+capability="agency\.analytics">\s*<RequireFlag\s+flag="agency_call_analysis">\s*<AnalysisProfilesPage\s*\/>\s*<\/RequireFlag>\s*<\/RequireCapability>\}/s,
    );
  });

  it('requires both gates before Call Summaries appears in Sidebar and GlobalSearch', () => {
    const sidebar = source('../../components/layout/Sidebar.tsx');
    const search = source('../../components/common/GlobalSearch.tsx');

    expect(sidebar).toMatch(
      /label:\s*'Call Summaries'[\s\S]*?flag:\s*'agency_call_analysis'[\s\S]*?capability:\s*'agency\.analytics'/,
    );
    expect(search).toMatch(
      /label:\s*'Call Summaries'[\s\S]*?flag:\s*'agency_call_analysis'[\s\S]*?capability:\s*'agency\.analytics'/,
    );
    expect(sidebar).toContain('&& (!item.flag || isFlagEnabled(item.flag))\n          && (!item.capability || isCapabilityEnabled(item.capability))');
    expect(search).toContain('(!page.flag || isEnabled(page.flag))\n      && (!page.capability || isCapabilityEnabled(page.capability))');
  });

  it('registers the analytics capability in the RequireCapability union and tracking gate set', () => {
    const guard = source('../../components/auth/RequireCapability.tsx');

    expect(guard).toMatch(/type KnownCapabilityGate\s*=\s*[\s\S]*?\| 'agency\.analytics'/);
    expect(guard).toMatch(/KNOWN_CAPABILITY_GATES[\s\S]*?'agency\.analytics'/);
  });
});
