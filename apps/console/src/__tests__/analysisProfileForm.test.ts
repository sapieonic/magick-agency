import { describe, it, expect } from 'vitest';
import {
  EMPTY_PROFILE_FORM,
  EMPTY_DIMENSION,
  toValidDimensions,
  buildCreatePayload,
  buildUpdatePayload,
  profileToForm,
  describeDimension,
  type DimensionRow,
} from '../pages/settings/analysisProfileForm';
import type { CallAnalysisProfile } from '../types/call-analysis-profile';

function row(overrides: Partial<DimensionRow> = {}): DimensionRow {
  return { ...EMPTY_DIMENSION, ...overrides };
}

describe('analysisProfileForm — dimension key derivation', () => {
  it('derives a snake_case key from the description', () => {
    const dims = toValidDimensions([
      row({ description: 'Whether the customer agreed to pay', type: 'boolean' }),
    ]);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.key).toBe('whether_the_customer_agreed_to_pay');
    expect(dims[0]!.type).toBe('boolean');
  });

  it('strips trailing underscores and caps the key at 50 chars', () => {
    const long = 'a'.repeat(80);
    const dims = toValidDimensions([row({ description: `${long} ` })]);
    expect(dims[0]!.key.length).toBeLessThanOrEqual(50);
    expect(dims[0]!.key.endsWith('_')).toBe(false);
  });

  it('preserves an existing valid key so stored analysis data is not orphaned', () => {
    const dims = toValidDimensions([
      row({ key: 'agreed_to_pay', description: 'Did they agree?' }),
    ]);
    expect(dims[0]!.key).toBe('agreed_to_pay');
  });

  it('does not let a new row displace a stored row’s key', () => {
    const dims = toValidDimensions([
      row({ key: '', description: 'Visit date!' }),
      row({ key: 'visit_date', description: 'When they visit' }),
    ]);
    expect(dims[1]!.key).toBe('visit_date');
    expect(dims[0]!.key).toBe('visit_date_2');
  });

  it('dedupes two derived keys that collide', () => {
    const dims = toValidDimensions([
      row({ description: 'Visit date' }),
      row({ description: 'Visit date!' }),
    ]);
    expect(dims.map(d => d.key)).toEqual(['visit_date', 'visit_date_2']);
  });
});

describe('analysisProfileForm — permissive filtering', () => {
  it('silently drops rows with a blank description (never errors)', () => {
    const dims = toValidDimensions([
      row({ description: '' }),
      row({ description: '   ' }),
      row({ description: 'Kept one' }),
    ]);
    expect(dims).toHaveLength(1);
    expect(dims[0]!.description).toBe('Kept one');
  });

  it('drops a row whose description is pure punctuation (no usable key)', () => {
    const dims = toValidDimensions([row({ description: '!!!' })]);
    expect(dims).toHaveLength(0);
  });

  it('keeps a valid enum with 2+ options', () => {
    const dims = toValidDimensions([
      row({ description: 'Outcome', type: 'enum', options: 'agreed, refused, callback' }),
    ]);
    expect(dims[0]!.type).toBe('enum');
    expect(dims[0]!.options).toEqual(['agreed', 'refused', 'callback']);
  });

  it('downgrades an enum with fewer than 2 options to Text rather than erroring', () => {
    const dims = toValidDimensions([
      row({ description: 'Outcome', type: 'enum', options: 'only-one' }),
    ]);
    expect(dims[0]!.type).toBe('string');
    expect(dims[0]!.options).toBeUndefined();
  });
});

describe('analysisProfileForm — payload assembly', () => {
  it('omits blank optional text on create', () => {
    const payload = buildCreatePayload({
      ...EMPTY_PROFILE_FORM,
      name: '  Collections  ',
    });
    expect(payload.name).toBe('Collections');
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('context');
    expect(payload.custom_dimensions).toEqual([]);
  });

  it('sends cleared text as empty string on update (so a deletion sticks)', () => {
    // On copy-on-write, an omitted field carries forward — so a cleared field
    // must be sent explicitly empty, not dropped.
    const payload = buildUpdatePayload({
      ...EMPTY_PROFILE_FORM,
      name: 'x',
      description: '',
      context: '',
    });
    expect(payload.description).toBe('');
    expect(payload.context).toBe('');
  });

  it('trims context and passes it through on create', () => {
    const payload = buildCreatePayload({
      ...EMPTY_PROFILE_FORM,
      name: 'x',
      context: '  Debt collection calls.  ',
    });
    expect(payload.context).toBe('Debt collection calls.');
  });
});

describe('analysisProfileForm — profileToForm round-trip', () => {
  it('maps enum options back to a comma-joined string', () => {
    const profile: CallAnalysisProfile = {
      id: 'p1', tenant_id: 't', account_id: 'a', name: 'Collections',
      description: 'desc', context: 'ctx',
      custom_dimensions: [
        { key: 'outcome', description: 'Outcome', type: 'enum', options: ['a', 'b'] },
      ],
      language_hint: null, is_default: true, is_active: true, version: 2,
      created_at: '', updated_at: '',
    };
    const form = profileToForm(profile);
    expect(form.name).toBe('Collections');
    expect(form.is_default).toBe(true);
    expect(form.custom_dimensions[0]!.options).toBe('a, b');
  });

  // The dimension list is the server's shared `analyticsDimensionSchema`, stored as
  // JSONB, so it can echo NULLs the send contract would reject. The page trims
  // every row during render (`toValidDimensions` in the preview `useMemo`), so a
  // NULL reaching the form would blank the settings page the moment the edit
  // modal opens — the same crash a call script hit.
  it('coerces null dimension fields so opening the edit modal cannot crash', () => {
    const profile: CallAnalysisProfile = {
      id: 'p1', tenant_id: 't', account_id: 'a', name: 'Legacy',
      description: null, context: null,
      custom_dimensions: [
        { key: null, description: null, type: 'enum', options: ['a', null] },
      ],
      language_hint: null, is_default: false, is_active: true, version: 1,
      created_at: '', updated_at: '',
    };
    const form = profileToForm(profile);
    expect(form.custom_dimensions[0]).toEqual({
      key: '',
      description: '',
      type: 'enum',
      options: 'a',
    });
    expect(() => toValidDimensions(form.custom_dimensions)).not.toThrow();
    expect(toValidDimensions(form.custom_dimensions)).toEqual([]);
  });
});

describe('analysisProfileForm — describeDimension (preview copy)', () => {
  it('describes each answer type in plain language', () => {
    expect(describeDimension({ key: 'k', description: 'd', type: 'boolean' })).toBe('yes or no');
    expect(describeDimension({ key: 'k', description: 'd', type: 'number' })).toBe('a number');
    expect(describeDimension({ key: 'k', description: 'd', type: 'string' })).toBe('a short piece of text');
    expect(
      describeDimension({ key: 'k', description: 'd', type: 'enum', options: ['x', 'y'] }),
    ).toBe('one of: x, y');
  });
});
