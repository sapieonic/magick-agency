import { parse } from 'csv-parse/sync';
import { normalizePhoneToE164 } from '../utils/phone-normalizer.js';

const MAX_ROWS = 10_000;
const MAX_COLUMNS = 50;
const MAX_ERRORS = 10;

// Permissive email shape check — mirrors the intent of phone validation without
// rejecting unusual-but-valid addresses. Format is ultimately owned by core.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(raw: string): boolean {
  return EMAIL_REGEX.test(raw);
}

/** Build a channel-appropriate error message for a row with no usable recipient. */
function rowRecipientError(
  rowNum: number,
  rawPhone: string,
  rawEmail: string,
  hasPhone: boolean,
  hasEmail: boolean,
): string {
  if (hasPhone && !hasEmail) {
    return `Row ${rowNum}: '${rawPhone}' is not a valid phone number`;
  }
  if (hasEmail && !hasPhone) {
    return `Row ${rowNum}: '${rawEmail}' is not a valid email address`;
  }
  return `Row ${rowNum}: no valid phone or email`;
}

export interface ParseError {
  row?: number;
  message: string;
}

export interface ParseResult {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  errors: ParseError[];
  warnings: string[];
}

export function parseCsv(buffer: Buffer): ParseResult {
  const errors: ParseError[] = [];
  const warnings: string[] = [];

  let records: string[][];
  try {
    records = parse(buffer, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    return { headers: [], rows: [], rowCount: 0, errors: [{ message: 'Failed to parse CSV. Ensure the file is valid CSV format.' }], warnings: [] };
  }

  if (records.length === 0) {
    return { headers: [], rows: [], rowCount: 0, errors: [{ message: 'CSV contains no data rows' }], warnings: [] };
  }

  const rawHeaders = records[0]!;

  if (rawHeaders.length > MAX_COLUMNS) {
    errors.push({ message: `CSV contains ${rawHeaders.length} columns. Maximum is ${MAX_COLUMNS}.` });
    return { headers: [], rows: [], rowCount: 0, errors, warnings };
  }

  const headers = rawHeaders.map((h) => h.trim());
  // A contact list is keyed on a recipient identifier. It is channel-agnostic:
  // voice/IVR/static/WhatsApp use `phone`, email campaigns use `email`. We accept
  // either (or both) and auto-detect per row which identifiers a contact carries.
  const phoneIndex = headers.findIndex((h) => h.toLowerCase() === 'phone');
  if (phoneIndex !== -1) headers[phoneIndex] = 'phone';
  const emailIndex = headers.findIndex((h) => h.toLowerCase() === 'email');
  if (emailIndex !== -1) headers[emailIndex] = 'email';

  const hasPhone = phoneIndex !== -1;
  const hasEmail = emailIndex !== -1;

  if (!hasPhone && !hasEmail) {
    errors.push({ message: "CSV must contain a 'phone' or 'email' column" });
    return { headers, rows: [], rowCount: 0, errors, warnings };
  }

  const dataRecords = records.slice(1);

  if (dataRecords.length === 0) {
    errors.push({ message: 'CSV contains no data rows' });
    return { headers, rows: [], rowCount: 0, errors, warnings };
  }

  if (dataRecords.length > MAX_ROWS) {
    errors.push({ message: `CSV contains ${dataRecords.length.toLocaleString()} rows. Maximum is ${MAX_ROWS.toLocaleString()}.` });
    return { headers, rows: [], rowCount: 0, errors, warnings };
  }

  const rows: Record<string, string>[] = [];
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  let errorCount = 0;
  let normalizedCount = 0;

  for (let i = 0; i < dataRecords.length; i++) {
    const record = dataRecords[i]!;
    if (record.every((field) => field.trim() === '')) continue;
    const rowNum = i + 2;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      // Normalize the recipient column keys to their lowercase structural key
      // ('phone'/'email'); preserve all other headers as-is.
      const key = j === phoneIndex ? 'phone' : j === emailIndex ? 'email' : headers[j]!;
      row[key] = record[j]?.trim() ?? '';
    }

    // Validate each recipient identifier the list carries. A row is valid when it
    // has at least one usable identifier, so a contact with only a phone (or only
    // an email) in a dual-column list is still accepted.
    // Any accepted row must carry a *valid* identifier or an *empty* one — never a
    // raw invalid string. Downstream consumers filter recipients by truthiness
    // (`row.phone`/`row.email`), so a persisted 'abc' phone would slip through as a
    // bogus recipient. Blanking unusable identifiers keeps that invariant.
    let phoneValid = false;
    const rawPhone = hasPhone ? (row.phone ?? '') : '';
    if (hasPhone && rawPhone !== '') {
      const normalized = normalizePhoneToE164(rawPhone);
      if (normalized) {
        if (normalized !== rawPhone) normalizedCount++;
        row.phone = normalized;
        phoneValid = true;
        if (seenPhones.has(normalized) && !warnings.some((w) => w.includes('duplicate phone'))) {
          warnings.push(`CSV contains duplicate phone numbers (first seen at row ${rowNum})`);
        }
        seenPhones.add(normalized);
      } else {
        row.phone = '';
      }
    }

    let emailValid = false;
    const rawEmail = hasEmail ? (row.email ?? '') : '';
    if (hasEmail && rawEmail !== '') {
      if (isValidEmail(rawEmail)) {
        emailValid = true;
        const dedupKey = rawEmail.toLowerCase();
        if (seenEmails.has(dedupKey) && !warnings.some((w) => w.includes('duplicate email'))) {
          warnings.push(`CSV contains duplicate email addresses (first seen at row ${rowNum})`);
        }
        seenEmails.add(dedupKey);
      } else {
        row.email = '';
      }
    }

    if (!phoneValid && !emailValid) {
      errorCount++;
      if (errorCount <= MAX_ERRORS) {
        errors.push({ row: rowNum, message: rowRecipientError(rowNum, rawPhone, rawEmail, hasPhone, hasEmail) });
      }
    }

    rows.push(row);
  }

  if (errorCount > MAX_ERRORS) {
    errors.push({ message: `...and ${errorCount - MAX_ERRORS} more errors` });
  }

  if (normalizedCount > 0) {
    warnings.push(`Normalized ${normalizedCount} phone number${normalizedCount !== 1 ? 's' : ''} to E.164 format`);
  }

  return { headers, rows, rowCount: rows.length, errors, warnings };
}
