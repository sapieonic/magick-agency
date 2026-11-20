import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read as text: the test run does not load CSS (a `?raw` import of it is empty).
const stationCss = readFileSync(resolve(__dirname, '../../components/agency/station/Station.module.css'), 'utf-8');
const globalCss = readFileSync(resolve(__dirname, '../../../../../packages/web-ui/src/global.css'), 'utf-8');

/**
 * Text the station draws on a fixed white must read in both themes (spec §6.7, AS14): 4.5:1 or
 * more, measured with the WCAG formula from the tokens' values in each theme block.
 */

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A token's value in the dark block (`:root`) and the light one (`[data-theme='light']`). */
function tokenInBothThemes(name: string): { dark: string; light: string } {
  const lightAt = globalCss.indexOf("[data-theme='light']");
  const find = (from: number, to: number) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})\\b`).exec(globalCss.slice(from, to));
    if (!m) throw new Error(`${name} not found`);
    return m[1]!;
  };
  return { dark: find(0, lightAt), light: find(lightAt, globalCss.length) };
}

/** The colour token a rule's `color` reads. */
function colourTokenOf(selector: string): string {
  const at = stationCss.indexOf(`${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const rule = stationCss.slice(at, stationCss.indexOf('}', at));
  expect(rule).toMatch(/background:\s*#fff\b/);
  const m = /[^-]color:\s*var\((--[\w-]+)\)/.exec(rule);
  if (!m) throw new Error(`no colour token on ${selector}`);
  return m[1]!;
}

describe('05d’s red ring on its white pill', () => {
  it('reads at 4.5:1 or more in the light theme and in the dark one', () => {
    const token = colourTokenOf(".ring[data-over='true']");
    const { dark, light } = tokenInBothThemes(token);
    expect(contrast(light, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
