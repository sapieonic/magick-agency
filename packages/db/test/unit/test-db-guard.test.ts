import { describe, expect, it } from 'vitest';
import { assertSafeTestDbUrl } from '../helpers/test-db.js';

describe('test database guard', () => {
  it('accepts a per-worktree test database on 5436', () => {
    expect(() =>
      assertSafeTestDbUrl('postgresql://u:p@localhost:5436/magick_agency_test_lane_c'),
    ).not.toThrow();
  });

  it('accepts the agency test database on 5436', () => {
    expect(() =>
      assertSafeTestDbUrl('postgresql://u:p@localhost:5436/magick_agency_test'),
    ).not.toThrow();
  });

  it.each([
    ['core dev', 'postgresql://u:p@localhost:5432/magick_agency_test'],
    ['master dev / core test', 'postgresql://u:p@localhost:5433/magick_agency_test'],
    ['master test', 'postgresql://u:p@localhost:5434/magick_agency_test'],
    ['agency dev database', 'postgresql://u:p@localhost:5436/magick_agency'],
    ['lookalike name', 'postgresql://u:p@localhost:5436/magick_agency_testing'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDbUrl(url)).toThrow(/REFUSING TO RUN/);
  });
});
