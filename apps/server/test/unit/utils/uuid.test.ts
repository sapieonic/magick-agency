import { describe, expect, it } from 'vitest';
import { isUuid } from '../../../src/utils/uuid.js';

describe('isUuid', () => {
  it('takes a UUID in either case and nothing else', () => {
    expect(isUuid('0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9')).toBe(true);
    expect(isUuid('0B1C2D3E-4F50-4617-8293-A4B5C6D7E8F9')).toBe(true);
    for (const v of ['', 'x', '0b1c2d3e4f5046178293a4b5c6d7e8f9', ' 0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', null, undefined, 42, {}]) {
      expect(isUuid(v), String(v)).toBe(false);
    }
  });
});
