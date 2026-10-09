import { describe, it, expect } from 'vitest';
import { resolveContextFields, heroesWereConfigured } from '../../utils/agencyContext';

/**
 * The resolution rules are a CROSS-CLIENT contract — core's `AgencyContextDisplay`
 * states them so "two clients agree". These tests are written against that
 * wording rather than against the implementation.
 */

const CONTEXT = {
  'First Name': 'Asha',
  'Policy #': 'POL-1',
  City: 'Mumbai',
  'Amount Due': '12345.67',
  Notes: '',
  Branch: 'Andheri West',
};

describe('context resolution — the four rules', () => {
  it('renders hero first, pinned, in ARRAY order (not CSV order)', () => {
    const resolved = resolveContextFields(CONTEXT, {
      hero: ['Amount Due', 'First Name'],
    });
    expect(resolved.hero.map((f) => f.label)).toEqual(['Amount Due', 'First Name']);
  });

  it('then `order`, in array order, then the rest in ORIGINAL CSV order', () => {
    const resolved = resolveContextFields(CONTEXT, {
      hero: ['First Name'],
      order: ['Branch', 'City'],
    });
    // Ordered names first, then everything else in the order the file had them.
    expect(resolved.fields.map((f) => f.label)).toEqual([
      'Branch',
      'City',
      'Policy #',
      'Amount Due',
    ]);
  });

  it('keeps original CSV order, NOT alphabetical, for the non-hero remainder', () => {
    // The agency built that file and put the thing that matters in column 3.
    // Hero is pinned explicitly here so the heuristic does not select for us —
    // otherwise this would be asserting the heuristic's output, not the order.
    const resolved = resolveContextFields(CONTEXT, { hero: ['First Name'] });
    const labels = resolved.fields.map((f) => f.label);

    expect(labels).toEqual(['Policy #', 'City', 'Amount Due', 'Branch']);
    // Alphabetical would be Amount Due, Branch, City, Policy #.
    expect(labels).not.toEqual([...labels].sort());
  });

  it('hides `hidden` at EVERY stage, including from hero', () => {
    // A column in both hero and hidden is hidden — precedence, stated once.
    const resolved = resolveContextFields(CONTEXT, {
      hero: ['First Name', 'Amount Due'],
      order: ['Amount Due'],
      hidden: ['Amount Due'],
    });
    expect(resolved.hero.map((f) => f.label)).toEqual(['First Name']);
    expect(resolved.fields.map((f) => f.label)).not.toContain('Amount Due');
    expect(resolved.empty.map((f) => f.label)).not.toContain('Amount Due');
  });

  it('renders every column in original order when there is no operator opinion', () => {
    const noConfig = resolveContextFields(CONTEXT, undefined);
    const emptyConfig = resolveContextFields(CONTEXT, {});
    expect(noConfig.fields.map((f) => f.label)).toEqual(emptyConfig.fields.map((f) => f.label));
  });
});

describe('context resolution — robustness', () => {
  it('caps hero at four', () => {
    const resolved = resolveContextFields(CONTEXT, {
      hero: ['First Name', 'Policy #', 'City', 'Amount Due', 'Branch'],
    });
    expect(resolved.hero).toHaveLength(4);
  });

  it('skips a configured hero column this contact does not have', () => {
    // Campaigns outlive file formats; a stale hero entry must not become an
    // empty pinned field.
    const resolved = resolveContextFields(CONTEXT, { hero: ['Nonexistent', 'City'] });
    expect(resolved.hero.map((f) => f.label)).toEqual(['City']);
  });

  it('matches configured names case- and whitespace-insensitively', () => {
    const resolved = resolveContextFields(CONTEXT, { hero: ['  first name  '] });
    expect(resolved.hero.map((f) => f.label)).toEqual(['First Name']);
  });

  it('collapses empty and placeholder values out of the main list', () => {
    const resolved = resolveContextFields(
      { Name: 'Asha', A: '', B: '   ', C: '-', D: 'N/A', E: 'real' },
      { hero: ['Name'] },
    );
    expect(resolved.fields.map((f) => f.label)).toEqual(['E']);
    expect(resolved.empty.map((f) => f.label)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('renders a nested value as readable text, never [object Object]', () => {
    // `context` is operator-uploaded JSONB — unusual shapes are possible.
    const resolved = resolveContextFields({ Meta: { a: 1 }, List: [1, 2] }, {});
    const values = resolved.fields.map((f) => f.value);
    expect(values).toContain('{"a":1}');
    expect(values).toContain('[1,2]');
    expect(values.join()).not.toContain('[object Object]');
  });

  it('returns an entirely empty result for a contact with no extra columns', () => {
    const resolved = resolveContextFields({}, {});
    expect(resolved.hero).toEqual([]);
    expect(resolved.fields).toEqual([]);
    expect(resolved.empty).toEqual([]);
  });
});

describe('heuristic hero selection', () => {
  it('picks at most one per bucket, in bucket order', () => {
    const resolved = resolveContextFields(CONTEXT, {});
    // name-ish, money-ish, identity-ish, place-ish.
    expect(resolved.hero.map((f) => f.label)).toEqual([
      'First Name',
      'Amount Due',
      'Policy #',
      'City',
    ]);
  });

  it('skips a heuristic match whose value is empty', () => {
    const resolved = resolveContextFields({ 'Customer Name': '', City: 'Pune' }, {});
    expect(resolved.hero.map((f) => f.label)).toEqual(['City']);
  });

  it('never guesses when the operator configured heroes', () => {
    const resolved = resolveContextFields(CONTEXT, { hero: ['Branch'] });
    expect(resolved.hero.map((f) => f.label)).toEqual(['Branch']);
  });

  it('reports whether heroes were configured, so the UI can label a guess', () => {
    // Showing a heuristic's output as if it were the operator's choice is how
    // an agent comes to trust the wrong four fields.
    expect(heroesWereConfigured({ hero: ['City'] })).toBe(true);
    expect(heroesWereConfigured({ hero: [] })).toBe(false);
    expect(heroesWereConfigured(undefined)).toBe(false);
  });
});
