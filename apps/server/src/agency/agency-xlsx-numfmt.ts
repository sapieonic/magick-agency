/**
 * Excel number formats for the Excel upload's conversion (`agency-xlsx.ts`, IM8): what a
 * format code makes of a number cell, so the CSV holds the number as the sheet shows it
 * (Manas, 2026-11-25): `1,25,000.00`, `15%`, `₹1,250.50`.
 *
 * A LEAF: no imports, no I/O. Each code is classified and compiled once per `numFmtId`
 * (`readStyles` memoises; {@link formatsCompiled} counts compilations for its test), in one
 * linear pass with no backtracking pattern; a code longer than {@link MAX_FORMAT_CODE_CHARS}
 * is not compiled at all. A compiled section carries its slots and flags, so rendering a
 * cell does no parsing.
 *
 * ── What is kept as before (the ruling's exceptions) ───────────────────────
 *  - General, and a scientific format: a whole number in full digits (never `9.19877E+11`),
 *    any other number at 15 significant digits ({@link plainNumber}).
 *  - A single-section all-zeros format of up to 32 zeros pads a whole number
 *    (`09876543210`); any other number under it is rendered (`000000` 12345.6 is `012346`).
 *  - Dates and times: `YYYY-MM-DD[ HH:mm[:ss]]` (the agent station's date fact reads it);
 *    elapsed formats as the duration in hours (`agency-xlsx.ts`, `excelSerialToText`).
 *  - A phone column's whole numbers in full digits whatever the format (`agency-xlsx.ts`).
 *
 * ── What a format renders ───────────────────────────────────────────────────
 *  - Up to four sections (positive; negative; zero; text). A last section holding an
 *    unquoted `@` is the text section whatever its position, and the numeric ones before it
 *    are read as Excel and LibreOffice read them (one: every number; two: positive and zero,
 *    negative). One numeric section: a negative number gets a leading `-` (before any
 *    currency symbol). A negative number in the negative section shows without its sign,
 *    as that section writes it (`(1,250.00)`, `5 Dr`), unless the section looks like the
 *    positive one (the same literal text in the same places; only digits and colour differ):
 *    then the colour carried the sign, and it gets the leading `-` (`0.00;[Red]0.00` is
 *    `-1250.00`). A section with words of its own (`0" Cr";0" Dr"`) is written as shown.
 *  - Conditions (`[>=100000]`) pick the section, as Excel's Indian lakh format does; a value
 *    no condition meets falls to the first section without one; a negative number under a
 *    condition gets its `-` unless the condition is `<` or `<=` zero or less (LibreOffice's
 *    rule: `[<0]"owes "0` writes `owes 5`). A bracket that looks like a condition but does not
 *    parse makes the format fall back.
 *  - **Zero is zero:** a value whose shown digits are all zero is written as zero, with the
 *    zero section if there is one, else the positive section: never `-0`, `-₹0` or `(0)`.
 *    (A deliberate departure: Excel writes `-0` for `0` and -0.4.)
 *  - Colour tags dropped; a currency or locale tag gives its symbol (`[$₹-4009]` is `₹`,
 *    `[$-409]` nothing); quoted text and backslash escapes as written; `_x` one space;
 *    `*x` (fill) nothing.
 *  - `0`, `#`, `?` digit placeholders, `.`, `%` (×100 each), a thousands comma, a trailing
 *    comma (÷1,000 each), `General` inside a section. Rounding is Excel's: half away from
 *    zero on the 15-digit decimal value, so 1.005 under `0.00` is `1.01`.
 *  - Grouping is Indian (3, then 2s: `12,50,000`), whatever the commas' positions (Manas,
 *    2026-11-25): how Excel shows `#,##0` on an Indian system, and what `#,##,##0` asks for in
 *    Google Sheets and LibreOffice. Literal commas (`##\,##\,##0`, the lakh format) place
 *    digits where they stand.
 *  - Built-in formats by id: 1–4, 9–10, 37–40 as ECMA-376 lists them; 5–8 and 41–44, which
 *    depend on the workbook's locale, in their en-IN form with `₹` (when styles.xml spells
 *    the code out, as Excel usually does, that code wins). 49 (`@`) is General.
 *  - Not rendered (the value rule instead): fractions (`# ?/?`), scientific formats, a
 *    thousands comma together with literals inside the digits, more than 32 forced integer
 *    digits, 30 decimals, 64 placeholders, 10 `%` signs or 10 scaling commas in a section,
 *    an unclosed bracket or quote, a condition that does not parse, a text-only format, and
 *    a number the format's scaling takes past what a double holds. So a cell costs at most a
 *    few hundred steps, whatever its format.
 */

/** A number format longer than this (Excel's own limit is 255) is read as a plain number. */
export const MAX_FORMAT_CODE_CHARS = 1_024;
/** The widest all-zeros format kept as padding; wider ones are plain numbers. */
export const MAX_PAD_WIDTH = 32;
/** Forced integer digits and decimals a rendered format may ask for (Excel allows 30 decimals). */
const MAX_FORCED_INTEGER_DIGITS = 32;
const MAX_DECIMALS = 30;
/** Digit placeholders one section may hold: a phone or lakh format has about ten. Bounds each cell's work. */
const MAX_PLACEHOLDERS = 64;
/** `%` signs, and scaling commas, one section may hold. */
const MAX_SCALERS = 10;
/** Sections a format has at most: positive; negative; zero; text. */
const MAX_SECTIONS = 4;

type Comparison = '<' | '<=' | '>' | '>=' | '=' | '<>';

interface DigitSlot {
  t: 'digit';
  c: '0' | '#' | '?';
  frac: boolean;
}

type Token =
  | { t: 'lit'; s: string }
  | DigitSlot
  | { t: 'point' }
  | { t: 'general' };

export interface FormatSection {
  condition: { op: Comparison; value: number } | null;
  tokens: Token[];
  /** A thousands comma between integer placeholders. */
  thousands: boolean;
  /** ×100 per `%`, ÷1,000 per trailing comma. */
  factor: number;
  /** An unquoted `@`: the text section. */
  text: boolean;
  /**
   * The section's literal text in order, each run of digits (placeholders, the point,
   * `General`) one marker: two sections with the same shape differ only in their digits and
   * colour, so a negative section shaped like the positive one leaves the sign to its colour.
   */
  shape: string;
  /** Not rendered faithfully: the caller writes the value instead. */
  fallback: boolean;
  intSlots: DigitSlot[];
  fracSlots: DigitSlot[];
  /** Forced integer digits (`0` before the point). */
  forced: number;
  hasDigits: boolean;
  hasGeneral: boolean;
}

export type NumberStyle =
  | { kind: 'plain' }
  | { kind: 'pad'; width: number; format: NumberStyle }
  | { kind: 'date'; hasTime: boolean }
  | { kind: 'time'; elapsed: boolean }
  | { kind: 'format'; sections: FormatSection[] };

export const PLAIN: NumberStyle = { kind: 'plain' };

let compilations = 0;

/** For tests: how many format codes have been compiled (each `numFmtId` once per workbook). */
export function formatsCompiled(): number {
  return compilations;
}

// ─── The value rule ─────────────────────────────────────────────────────────

/** A whole number's digits in full (`BigInt` of an integral double is exact). */
function integerDigits(x: number): string {
  return BigInt(x).toString();
}

/** `1.5e-7` as `0.00000015`: the only exponent a 15-digit, non-integral number can carry is negative. */
function expandExponent(text: string): string {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!m) return text;
  const [, sign, lead, rest = '', exp] = m;
  const digits = lead! + rest;
  const point = 1 + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`.replace(/0+$/, '');
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A number as plain decimal digits: whole numbers in full, others at Excel's 15 significant digits. */
export function plainNumber(x: number): string {
  if (x === 0) return '0';
  if (Number.isInteger(x)) return integerDigits(x);
  const rounded = Number(x.toPrecision(15));
  if (Number.isInteger(rounded)) return rounded === 0 ? '0' : integerDigits(rounded);
  const text = String(rounded);
  return /e/i.test(text) ? expandExponent(text) : text;
}

/** An all-zeros format's padding of a whole number (`09876543210`). */
export function padNumber(x: number, width: number): string {
  const digits = integerDigits(Math.abs(x)).padStart(width, '0');
  return x < 0 ? `-${digits}` : digits;
}


// ─── Classification ─────────────────────────────────────────────────────────

/** The length of the code point at `i` (2 for a surrogate pair), so an escape takes all of it. */
function codePointLength(text: string, i: number): number {
  const cp = text.codePointAt(i);
  return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/** The sections of a code, split on `;` outside quotes, brackets and escapes. Linear. */
function splitSections(code: string): string[] {
  const sections: string[] = [];
  let start = 0;
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (bracket) {
      if (ch === ']') bracket = false;
      continue;
    }
    if (ch === '\\' || ch === '_' || ch === '*') {
      if (i + 1 < code.length) i += codePointLength(code, i + 1);
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '[') bracket = true;
    else if (ch === ';') {
      sections.push(code.slice(start, i));
      start = i + 1;
    }
  }
  sections.push(code.slice(start));
  return sections;
}

/**
 * What a custom format code shows a number as. The first section decides between a date,
 * a time and a number: quoted text, escaped and padding characters and bracketed parts
 * (colours, locales, conditions) say nothing about dates; a bracketed `[h]`, `[m]` or `[s]`
 * marks an elapsed time. A single section of 2 to 32 zeros pads a whole number; everything
 * else is compiled ({@link compileFormat}). A code longer than {@link MAX_FORMAT_CODE_CHARS}
 * is plain.
 */
export function classifyNumberFormat(code: string): NumberStyle {
  if (code.length > MAX_FORMAT_CODE_CHARS) return PLAIN;
  let bare = '';
  let elapsed = false;
  let i = 0;
  scan: while (i < code.length) {
    const ch = code[i]!;
    switch (ch) {
      case ';':
        break scan;
      case '"': {
        const end = code.indexOf('"', i + 1);
        i = end === -1 ? code.length : end + 1;
        continue;
      }
      case '\\':
      case '_':
      case '*':
        i += 1 + (i + 1 < code.length ? codePointLength(code, i + 1) : 0);
        continue;
      case '[': {
        const end = code.indexOf(']', i + 1);
        const inside = end === -1 ? '' : code.slice(i + 1, end);
        if (/^(?:h+|m+|s+)$/i.test(inside)) elapsed = true;
        i = end === -1 ? code.length : end + 1;
        continue;
      }
      default:
        bare += ch;
        i += 1;
    }
  }
  const section = bare.trim();
  const withoutGeneral = section.replace(/general/gi, '');
  const date = /[dy]/i.test(withoutGeneral);
  const time = /[hs]/i.test(withoutGeneral) || elapsed;
  if (date) return { kind: 'date', hasTime: time };
  if (time) return { kind: 'time', elapsed };
  // `m` alone is a month (`mmmm`); with an hour or second it is minutes, caught above.
  if (/m/i.test(withoutGeneral)) return { kind: 'date', hasTime: false };
  const format = compileFormat(code);
  // One section of zeros and nothing else (no literal, no colour, no other section): padding.
  const trimmed = code.trim();
  if (/^0{2,}$/.test(trimmed) && trimmed.length <= MAX_PAD_WIDTH) return { kind: 'pad', width: trimmed.length, format };
  return format;
}

// ─── Compiling a number format ──────────────────────────────────────────────

const isPlaceholder = (ch: string | undefined): boolean => ch === '0' || ch === '#' || ch === '?';

/** `[>=100000]` as a condition; null for anything else in brackets. */
function parseCondition(inside: string): { op: Comparison; value: number } | null {
  const m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(inside);
  return m ? { op: m[1] as Comparison, value: Number(m[2]) } : null;
}

/** `$₹-4009` is `₹`, `$-409` nothing, `$€-x-euro` `€`, `$Rs.` `Rs.`. */
function currencySymbol(inside: string): string {
  const body = inside.slice(1);
  const dash = body.indexOf('-');
  return dash === -1 ? body : body.slice(0, dash);
}

function compileSection(text: string): FormatSection {
  const section: FormatSection = {
    condition: null, tokens: [], thousands: false, factor: 1, text: false, shape: '', fallback: false,
    intSlots: [], fracSlots: [], forced: 0, hasDigits: false, hasGeneral: false,
  };
  const tokens = section.tokens;
  const fallback = (): FormatSection => ({ ...section, fallback: true });
  let seenPoint = false;
  let interiorLiteral = false;
  let lastWasDigit = false;
  let percents = 0;
  let scaleCommas = 0;
  const lit = (s: string) => {
    if (s === '') return;
    const last = tokens[tokens.length - 1];
    if (last?.t === 'lit') last.s += s;
    else tokens.push({ t: 'lit', s });
    lastWasDigit = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    switch (ch) {
      case '"': {
        const end = text.indexOf('"', i + 1);
        if (end === -1) return fallback();
        lit(text.slice(i + 1, end));
        i = end;
        break;
      }
      case '\\': {
        if (i + 1 >= text.length) break;
        const width = codePointLength(text, i + 1);
        lit(text.slice(i + 1, i + 1 + width));
        i += width;
        break;
      }
      case '_':
        lit(' ');
        if (i + 1 < text.length) i += codePointLength(text, i + 1);
        break;
      case '*':
        if (i + 1 < text.length) i += codePointLength(text, i + 1);
        lastWasDigit = false;
        break;
      case '[': {
        const end = text.indexOf(']', i + 1);
        if (end === -1) return fallback();
        const inside = text.slice(i + 1, end);
        if (inside.startsWith('$')) lit(currencySymbol(inside));
        else if (/^[<>=]/.test(inside)) {
          const condition = parseCondition(inside);
          if (!condition) return fallback();
          section.condition = condition;
        }
        // Anything else in brackets is a colour or a locale: not shown.
        i = end;
        break;
      }
      case '0':
      case '#':
      case '?': {
        // An integer placeholder after a literal that followed digits: the literal sits among
        // the digits (`##\,##0`), which places them; with a thousands comma it cannot.
        if (section.hasDigits && !seenPoint && !lastWasDigit && tokens[tokens.length - 1]?.t === 'lit') interiorLiteral = true;
        const slot: DigitSlot = { t: 'digit', c: ch, frac: seenPoint };
        tokens.push(slot);
        (seenPoint ? section.fracSlots : section.intSlots).push(slot);
        if (section.intSlots.length + section.fracSlots.length > MAX_PLACEHOLDERS) return fallback();
        if (!seenPoint && ch === '0') section.forced += 1;
        section.hasDigits = true;
        lastWasDigit = true;
        break;
      }
      case '.':
        if (!seenPoint) {
          tokens.push({ t: 'point' });
          seenPoint = true;
          lastWasDigit = false;
        } else lit('.');
        break;
      case ',':
        // Between integer placeholders: grouping. After the last placeholder: ÷1,000 each.
        if (lastWasDigit && !seenPoint && isPlaceholder(text[i + 1])) section.thousands = true;
        else if (lastWasDigit) scaleCommas += 1;
        else lit(',');
        break;
      case '%':
        percents += 1;
        lit('%');
        break;
      case 'E':
      case 'e':
        if (text[i + 1] === '+' || text[i + 1] === '-') return fallback();
        lit(ch);
        break;
      case '/':
        if (section.hasDigits) return fallback();
        lit('/');
        break;
      case '@':
        section.text = true;
        lastWasDigit = false;
        break;
      case 'G':
      case 'g':
        if (text.slice(i, i + 7).toLowerCase() === 'general') {
          tokens.push({ t: 'general' });
          section.hasGeneral = true;
          lastWasDigit = false;
          i += 6;
        } else lit(ch);
        break;
      default:
        lit(ch);
    }
  }
  if (
    section.forced > MAX_FORCED_INTEGER_DIGITS || section.fracSlots.length > MAX_DECIMALS
    || percents > MAX_SCALERS || scaleCommas > MAX_SCALERS || (section.thousands && interiorLiteral)
  ) {
    return fallback();
  }
  section.factor = 100 ** percents / 1000 ** scaleCommas;
  // Literals as written, each run of digit tokens one marker (U+0000 is never in a literal shown).
  let shape = '';
  let inNumber = false;
  for (const token of tokens) {
    if (token.t === 'lit') {
      shape += token.s;
      inNumber = false;
    } else if (!inNumber) {
      shape += '\u0000';
      inNumber = true;
    }
  }
  section.shape = shape;
  return section;
}

/** A number format code compiled into its sections. Linear in the code's length. */
export function compileFormat(code: string): NumberStyle {
  if (code.length > MAX_FORMAT_CODE_CHARS) return PLAIN;
  compilations += 1;
  const sections = splitSections(code).slice(0, MAX_SECTIONS).map(compileSection);
  // A format whose only section is General is General.
  if (sections.length === 1 && sections[0]!.tokens.length === 1 && sections[0]!.hasGeneral) return PLAIN;
  return { kind: 'format', sections };
}

/** Excel's built-in formats by id, the locale-dependent ones (5–8, 41–44) as en-IN shows them. */
const BUILT_IN_CODES: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"₹"#,##0;\\-"₹"#,##0',
  6: '"₹"#,##0;[Red]\\-"₹"#,##0',
  7: '"₹"#,##0.00;\\-"₹"#,##0.00',
  8: '"₹"#,##0.00;[Red]\\-"₹"#,##0.00',
  9: '0%',
  10: '0.00%',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  41: '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ ',
  42: '_ "₹"* #,##0_ ;_ "₹"* \\-#,##0_ ;_ "₹"* "-"_ ;_ @_ ',
  43: '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ ',
  44: '_ "₹"* #,##0.00_ ;_ "₹"* \\-#,##0.00_ ;_ "₹"* "-"??_ ;_ @_ ',
};

const builtInCache = new Map<number, NumberStyle>();

/** A built-in number format (no code in styles.xml): dates and times by Excel's ids, numbers as above. */
export function builtInStyle(id: number): NumberStyle {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return { kind: 'date', hasTime: false };
  if (id === 22) return { kind: 'date', hasTime: true };
  if ((id >= 18 && id <= 21) || id === 45 || id === 47) return { kind: 'time', elapsed: false };
  if (id === 46) return { kind: 'time', elapsed: true };
  const code = BUILT_IN_CODES[id];
  if (code === undefined) return PLAIN;
  let style = builtInCache.get(id);
  if (style === undefined) {
    style = compileFormat(code);
    builtInCache.set(id, style);
  }
  return style;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function meets(x: number, condition: { op: Comparison; value: number }): boolean {
  switch (condition.op) {
    case '<': return x < condition.value;
    case '<=': return x <= condition.value;
    case '>': return x > condition.value;
    case '>=': return x >= condition.value;
    case '=': return x === condition.value;
    case '<>': return x !== condition.value;
  }
}

/**
 * The section for `x` and whether a `-` goes in front, as Excel picks them. A last section
 * with an unquoted `@` is the text section and is never picked for a number.
 */
function pickSection(x: number, sections: FormatSection[]): { section: FormatSection; minus: boolean } | null {
  const last = sections[sections.length - 1];
  const numeric = (sections.length < MAX_SECTIONS && sections.length > 1 && last?.text ? sections.slice(0, -1) : sections).slice(0, 3);
  if (numeric.some((s) => s.condition !== null)) {
    for (const s of numeric) {
      if (s.condition && meets(x, s.condition)) {
        // LibreOffice's rule: a section for values below zero writes its own sign.
        const ownSign = (s.condition.op === '<' || s.condition.op === '<=') && s.condition.value <= 0;
        return { section: s, minus: x < 0 && !ownSign };
      }
    }
    const fallback = numeric.find((s) => s.condition === null);
    return fallback ? { section: fallback, minus: x < 0 } : null;
  }
  if (numeric.length === 1) return { section: numeric[0]!, minus: x < 0 };
  // By sign: a negative section shaped like the positive one (a red-negative format: the colour
  // carried the sign) gets a minus; one with words or brackets of its own is written as shown.
  if (x < 0) return { section: numeric[1]!, minus: numeric[1]!.shape === numeric[0]!.shape };
  if (x === 0 && numeric.length >= 3) return { section: numeric[2]!, minus: false };
  return { section: numeric[0]!, minus: false };
}

/**
 * A non-negative number's integer and decimal digits, rounded half away from zero to
 * `places`, on its 15-significant-digit decimal value (as Excel rounds: 1.005 → 1.01).
 * The integer part has no leading zeros (`''` for zero).
 */
function roundedDigits(v: number, places: number): { int: string; frac: string } {
  if (v === 0) return { int: '', frac: '0'.repeat(places) };
  const [mantissa, exponent = '0'] = v.toPrecision(15).split('e');
  const [lead = '', rest = ''] = mantissa!.split('.');
  const digits = lead + rest;
  const point = lead.length + Number(exponent);
  let int: string;
  let frac: string;
  if (point <= 0) {
    int = '';
    frac = '0'.repeat(Math.min(-point, places + 1)) + digits;
  } else if (point >= digits.length) {
    int = digits + '0'.repeat(point - digits.length);
    frac = '';
  } else {
    int = digits.slice(0, point);
    frac = digits.slice(point);
  }
  if (frac.length > places) {
    const up = frac.charCodeAt(places) >= 0x35;
    frac = frac.slice(0, places);
    if (up) {
      const bumped = (BigInt(`${int}${frac}` || '0') + 1n).toString().padStart(int.length + places, '0');
      int = bumped.slice(0, bumped.length - places);
      frac = bumped.slice(bumped.length - places);
    }
  }
  frac = frac.padEnd(places, '0');
  return { int: int.replace(/^0+/, ''), frac };
}

/** Indian grouping, in one pass: the last three digits, then twos (`12,50,000`). */
function groupIndian(digits: string): string {
  const n = digits.length;
  if (n <= 3) return digits;
  const headLength = n - 3;
  let out = '';
  let i = 0;
  // The first group of the head is one digit when the head is odd, then twos.
  if (headLength % 2 === 1) {
    out = digits[0]!;
    i = 1;
  }
  for (; i < headLength; i += 2) out += (out === '' ? '' : ',') + digits.slice(i, i + 2);
  return `${out},${digits.slice(headLength)}`;
}

/** One section's text for a non-negative `v` (already scaled), the digits rounded as `rounded`. */
function renderSection(section: FormatSection, v: number, rounded: { int: string; frac: string }): string {
  const { intSlots, fracSlots } = section;
  const { int, frac } = rounded;

  // Integer digits per placeholder, right-aligned; more digits than places go to the first.
  const intOut: string[] = new Array<string>(intSlots.length).fill('');
  if (section.thousands) {
    if (intSlots.length > 0) intOut[intSlots.length - 1] = groupIndian(int.padStart(section.forced, '0'));
  } else {
    for (let k = 0; k < intSlots.length; k += 1) {
      const slot = intSlots[intSlots.length - 1 - k]!;
      const digit = int[int.length - 1 - k];
      intOut[intSlots.length - 1 - k] = digit ?? (slot.c === '0' ? '0' : slot.c === '?' ? ' ' : '');
    }
    if (int.length > intSlots.length && intSlots.length > 0) intOut[0] = int.slice(0, int.length - intSlots.length) + intOut[0];
  }

  // Decimal digits; trailing zeros under `#` dropped, under `?` spaces.
  const fracOut = fracSlots.map((_, i) => frac[i]!);
  for (let i = fracSlots.length - 1; i >= 0; i -= 1) {
    const slot = fracSlots[i]!;
    if (slot.c === '0' || fracOut[i] !== '0') break;
    fracOut[i] = slot.c === '?' ? ' ' : '';
  }

  let out = '';
  let pointAt = -1;
  let intIndex = 0;
  let fracIndex = 0;
  for (const token of section.tokens) {
    switch (token.t) {
      case 'lit':
        out += token.s;
        break;
      case 'point':
        pointAt = out.length;
        out += '.';
        break;
      case 'general':
        out += plainNumber(v);
        break;
      case 'digit':
        out += token.frac ? fracOut[fracIndex++] : intOut[intIndex++];
        break;
    }
  }
  // A format with no integer placeholder (`.00`) still shows the integer, before its point.
  if (intSlots.length === 0 && int !== '' && section.hasDigits && pointAt !== -1) {
    out = out.slice(0, pointAt) + int + out.slice(pointAt);
  }
  return out;
}

/**
 * A number as its format shows it, or null when the format is not rendered (the caller
 * writes the value instead). `style` is a compiled number format.
 */
export function renderFormattedNumber(x: number, style: Extract<NumberStyle, { kind: 'format' }>): string | null {
  let picked = pickSection(x, style.sections);
  if (!picked) return null;
  let { section } = picked;
  if (section.fallback) return null;

  let v = Math.abs(x) * section.factor;
  if (!Number.isFinite(v)) return null;
  let rounded = roundedDigits(v, section.fracSlots.length);

  // Zero is zero: a negative (or tiny) value whose shown digits are all zero is written as 0,
  // in the zero section if there is one, else the positive one; never `-0` or `(0)`.
  if (x !== 0 && !section.hasGeneral && !/[1-9]/.test(rounded.int + rounded.frac)) {
    picked = pickSection(0, style.sections);
    if (!picked || picked.section.fallback) return null;
    section = picked.section;
    v = 0;
    rounded = roundedDigits(0, section.fracSlots.length);
    picked = { section, minus: false };
  }
  if (section.tokens.length === 0) return '';
  const out = renderSection(section, v, rounded);
  return picked.minus ? `-${out}` : out;
}
