import { describe, it, expect } from 'vitest';
import { csvNumberCell, escapeCsvCell, escapeCsvValue, toCsvLine } from '../../../src/agency/agency-csv.js';

/**
 * The CSV cell writer shared by every agency export (`agency-csv.ts`): text cells are quoted and
 * formula-guarded; a number cell (`csvNumberCell`, built only from a `number`) is written as it
 * is, so a negative number stays a number (`docs/call-log.md` §10, CL49).
 */
describe('toCsvLine: text cells and number cells', () => {
  it('a negative number cell is written unguarded', () => {
    expect(toCsvLine([csvNumberCell(-0.4)])).toBe('-0.4\n');
    expect(toCsvLine([csvNumberCell(-1500), csvNumberCell(0), csvNumberCell(5e-7), csvNumberCell(1e21)])).toBe('-1500,0,5e-7,1e+21\n');
  });

  it('a string that looks like a number, or a formula, stays guarded', () => {
    expect(toCsvLine(['-0.4'])).toBe("'-0.4\n");
    expect(toCsvLine(['-1+2', '=1', '@x'])).toBe("'-1+2,'=1,'@x\n");
  });

  it('a phone number\'s + is still guarded', () => {
    expect(toCsvLine(['+919876500001'])).toBe("'+919876500001\n");
  });

  it('NaN and Infinity are written as an empty cell, never as text', () => {
    expect(toCsvLine([csvNumberCell(Number.NaN), csvNumberCell(Number.POSITIVE_INFINITY), csvNumberCell(Number.NEGATIVE_INFINITY)])).toBe(',,\n');
  });

  it('a text cell is written exactly as escapeCsvValue writes it', () => {
    for (const text of ['', 'plain', 'a,b', 'say "hi"', 'line\nbreak', ' =SUM(A1)', '-3']) {
      expect(escapeCsvCell(text)).toBe(escapeCsvValue(text));
    }
    expect(toCsvLine(['a,b', '', 'x'])).toBe('"a,b",,x\n');
  });
});
