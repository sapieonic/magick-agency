import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../../src/contact-lists/csv-parser.js';

describe('parseCsv', () => {
  it('should parse a valid CSV with phone and variable columns', () => {
    const csv = Buffer.from('phone,name,amount\n+919876543210,Raj,5000\n+919876543211,Priya,3000\n');
    const result = parseCsv(csv);
    expect(result.headers).toEqual(['phone', 'name', 'amount']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', name: 'Raj', amount: '5000' });
    expect(result.rowCount).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject CSV without a phone or email column', () => {
    const csv = Buffer.from('name,amount\nRaj,5000\n');
    const result = parseCsv(csv);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("'phone' or 'email' column") }),
    );
  });

  it('should match phone column case-insensitively', () => {
    const csv = Buffer.from('Phone,Name\n+919876543210,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.headers).toContain('phone');
  });

  it('should preserve original case of non-phone headers', () => {
    const csv = Buffer.from('phone,CUSTOMER_NAME,Amount_Due\n+919876543210,Raj,5000\n');
    const result = parseCsv(csv);
    expect(result.headers).toEqual(['phone', 'CUSTOMER_NAME', 'Amount_Due']);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', CUSTOMER_NAME: 'Raj', Amount_Due: '5000' });
  });

  it('should normalize PHONE header to lowercase while preserving other headers', () => {
    const csv = Buffer.from('PHONE,CUSTOMER_NAME,AMOUNT\n+919876543210,Raj,5000\n');
    const result = parseCsv(csv);
    expect(result.headers).toEqual(['phone', 'CUSTOMER_NAME', 'AMOUNT']);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', CUSTOMER_NAME: 'Raj', AMOUNT: '5000' });
  });

  it('should preserve mixed-case headers across multiple rows', () => {
    const csv = Buffer.from('phone,FirstName,Last_Name,EMI_Amount\n+919876543210,Raj,Kumar,5000\n+919876543211,Priya,Singh,3000\n');
    const result = parseCsv(csv);
    expect(result.headers).toEqual(['phone', 'FirstName', 'Last_Name', 'EMI_Amount']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', FirstName: 'Raj', Last_Name: 'Kumar', EMI_Amount: '5000' });
    expect(result.rows[1]).toEqual({ phone: '+919876543211', FirstName: 'Priya', Last_Name: 'Singh', EMI_Amount: '3000' });
  });

  it('should handle all-uppercase headers including PHONE', () => {
    const csv = Buffer.from('PHONE,NAME,AMOUNT\n+919876543210,Raj,5000\n');
    const result = parseCsv(csv);
    expect(result.headers[0]).toBe('phone');
    expect(result.rows[0]!['phone']).toBe('+919876543210');
    expect(result.rows[0]!['NAME']).toBe('Raj');
    expect(result.rows[0]!['AMOUNT']).toBe('5000');
    // Ensure lowercase keys don't exist for non-phone columns
    expect(result.rows[0]!['name']).toBeUndefined();
    expect(result.rows[0]!['amount']).toBeUndefined();
  });

  it('should report invalid phone numbers with row numbers', () => {
    const csv = Buffer.from('phone,name\n+919876543210,Raj\nabc,Priya\n+91,Amit\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.message).toContain('Row 3');
    expect(result.errors[1]!.message).toContain('Row 4');
  });

  it('should enforce max 10,000 rows', () => {
    const header = 'phone\n';
    const rows = Array.from({ length: 10001 }, (_, i) => `+9198765${String(i).padStart(5, '0')}\n`).join('');
    const csv = Buffer.from(header + rows);
    const result = parseCsv(csv);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('10,000') }),
    );
  });

  it('should enforce max 50 columns', () => {
    const headers = ['phone', ...Array.from({ length: 50 }, (_, i) => `col${i}`)].join(',');
    const values = ['+919876543210', ...Array.from({ length: 50 }, () => 'val')].join(',');
    const csv = Buffer.from(`${headers}\n${values}\n`);
    const result = parseCsv(csv);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('50') }),
    );
  });

  it('should skip empty rows', () => {
    const csv = Buffer.from('phone,name\n+919876543210,Raj\n\n\n+919876543211,Priya\n');
    const result = parseCsv(csv);
    expect(result.rowCount).toBe(2);
  });

  it('should handle quoted fields with commas', () => {
    const csv = Buffer.from('phone,name,address\n+919876543210,"Kumar, Raj","123, Main St"\n');
    const result = parseCsv(csv);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', name: 'Kumar, Raj', address: '123, Main St' });
  });

  it('should handle Unicode characters', () => {
    const csv = Buffer.from('phone,name\n+919876543210,राजेश\n');
    const result = parseCsv(csv);
    expect(result.rows[0]!.name).toBe('राजेश');
  });

  it('should warn on duplicate phone numbers', () => {
    const csv = Buffer.from('phone,name\n+919876543210,Raj\n+919876543210,Duplicate\n');
    const result = parseCsv(csv);
    expect(result.warnings).toContainEqual(expect.stringContaining('duplicate'));
    expect(result.rowCount).toBe(2);
  });

  it('should auto-prepend + to phone numbers missing the prefix', () => {
    const csv = Buffer.from('phone,name\n919876543210,Raj\n+919876543211,Priya\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]!.phone).toBe('+919876543210');
    expect(result.rows[1]!.phone).toBe('+919876543211');
    expect(result.warnings).toContainEqual(expect.stringContaining('Normalized'));
  });

  it('should auto-prepend +91 to bare 10-digit Indian numbers and normalize formatting', () => {
    const csv = Buffer.from('phone,name\n9876543210,Raj\n98765-43211,Priya\n09876543212,Amit\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]!.phone).toBe('+919876543210');
    expect(result.rows[1]!.phone).toBe('+919876543211');
    expect(result.rows[2]!.phone).toBe('+919876543212');
    expect(result.warnings).toContainEqual(expect.stringContaining('Normalized'));
  });

  it('should leave international E.164 numbers untouched', () => {
    const csv = Buffer.from('phone,name\n+12025551234,Alice\n+442071838750,Bob\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]!.phone).toBe('+12025551234');
    expect(result.rows[1]!.phone).toBe('+442071838750');
  });

  it('should not auto-prepend + to numbers that are genuinely invalid', () => {
    const csv = Buffer.from('phone,name\n0123,Short\nabc,Text\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(2);
  });

  it('should reject empty CSV (no data rows)', () => {
    const csv = Buffer.from('phone,name\n');
    const result = parseCsv(csv);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('no data rows') }),
    );
  });

  it('should cap errors at 10 and show summary', () => {
    const header = 'phone\n';
    const rows = Array.from({ length: 15 }, () => 'invalid\n').join('');
    const csv = Buffer.from(header + rows);
    const result = parseCsv(csv);
    expect(result.errors.length).toBeLessThanOrEqual(11);
    expect(result.errors[result.errors.length - 1]!.message).toContain('more errors');
  });

  // ── Email-only lists (auto-detection) ──────────────────────────────────────

  it('should accept an email-only CSV with no phone column', () => {
    const csv = Buffer.from('email,name\nraj@example.com,Raj\npriya@example.com,Priya\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.headers).toEqual(['email', 'name']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ email: 'raj@example.com', name: 'Raj' });
    expect(result.rowCount).toBe(2);
  });

  it('should match email column case-insensitively and normalize the header key', () => {
    const csv = Buffer.from('EMAIL,Name\nraj@example.com,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.headers).toEqual(['email', 'Name']);
    expect(result.rows[0]!.email).toBe('raj@example.com');
  });

  it('should report invalid email addresses with row numbers', () => {
    const csv = Buffer.from('email,name\nraj@example.com,Raj\nnot-an-email,Priya\n@bad,Amit\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.message).toContain('Row 3');
    expect(result.errors[0]!.message).toContain('not a valid email address');
    expect(result.errors[1]!.message).toContain('Row 4');
  });

  it('should warn on duplicate email addresses (case-insensitively)', () => {
    const csv = Buffer.from('email,name\nraj@example.com,Raj\nRAJ@example.com,Duplicate\n');
    const result = parseCsv(csv);
    expect(result.warnings).toContainEqual(expect.stringContaining('duplicate email'));
    expect(result.rowCount).toBe(2);
  });

  // ── Dual-column lists (phone + email) ──────────────────────────────────────

  it('should accept a CSV with both phone and email columns', () => {
    const csv = Buffer.from('phone,email,name\n+919876543210,raj@example.com,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', email: 'raj@example.com', name: 'Raj' });
  });

  it('should accept a dual-column row that carries only one valid identifier', () => {
    // First row: valid phone, no email. Second row: no phone, valid email. Both usable.
    const csv = Buffer.from('phone,email,name\n+919876543210,,Raj\n,priya@example.com,Priya\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('should reject a dual-column row that has neither a valid phone nor email', () => {
    const csv = Buffer.from('phone,email,name\nabc,not-an-email,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('no valid phone or email');
  });

  it('should still error on a blank phone in a phone-only list (old-behavior guard)', () => {
    const csv = Buffer.from('phone,name\n+919876543210,Raj\n,Priya\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('Row 3');
  });

  it('should blank an invalid phone on an accepted dual-column row (kept email valid)', () => {
    // Contract for downstream `filter(Boolean)` consumers: an accepted row must
    // never carry a raw invalid identifier — it is blanked, not preserved as 'abc'.
    const csv = Buffer.from('phone,email,name\nabc,raj@example.com,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toEqual({ phone: '', email: 'raj@example.com', name: 'Raj' });
  });

  it('should blank an invalid email on an accepted dual-column row (kept phone valid)', () => {
    const csv = Buffer.from('phone,email,name\n+919876543210,garbage,Raj\n');
    const result = parseCsv(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toEqual({ phone: '+919876543210', email: '', name: 'Raj' });
  });

  it('should cap errors at 10 for an email-only list and show summary', () => {
    const header = 'email\n';
    const rows = Array.from({ length: 15 }, () => 'not-an-email\n').join('');
    const csv = Buffer.from(header + rows);
    const result = parseCsv(csv);
    expect(result.errors.length).toBeLessThanOrEqual(11);
    expect(result.errors[result.errors.length - 1]!.message).toContain('more errors');
  });
});
