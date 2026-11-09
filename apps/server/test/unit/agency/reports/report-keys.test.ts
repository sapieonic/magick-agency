import { describe, expect, it } from 'vitest';
import {
  isReportOutputKey,
  REPORT_DATASETS_PREFIX,
  REPORTS_PREFIX,
  reportDatasetKey,
  reportDatasetPrefix,
  reportDetailKey,
  reportOutputKey,
  reportOutputPrefix,
} from '../../../../src/agency/reports/report-keys.js';

/*
 * Report S3 keys (docs/reports.md "S3 keys"): derived from the run row's own UUIDs only, refused
 * for anything else, one canonical spelling per run. Mutation-checked: dropping the UUID check
 * reds the path-traversal and empty-id cases; using the tenant id for an unscoped run's segment
 * reds the `tenant` literal case.
 */

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const scope = { tenantId: T, accountId: A, runId: R };

describe('report keys', () => {
  it('dataset, detail and output keys under the two lifecycle prefixes', () => {
    expect(reportDatasetPrefix(scope)).toBe(`report-datasets/${T}/${A}/${R}/`);
    expect(reportDatasetKey(scope)).toBe(`report-datasets/${T}/${A}/${R}/dataset.json`);
    expect(reportDetailKey(scope, 'state_log')).toBe(`report-datasets/${T}/${A}/${R}/details-state_log.ndjson.gz`);
    expect(reportOutputPrefix(scope)).toBe(`reports/${T}/${A}/${R}/`);
    expect(reportOutputKey(scope, 'pdf')).toBe(`reports/${T}/${A}/${R}/report.pdf`);
    expect(reportOutputKey(scope, 'xlsx')).toBe(`reports/${T}/${A}/${R}/report.xlsx`);
    expect(reportDatasetKey(scope).startsWith(REPORT_DATASETS_PREFIX)).toBe(true);
    expect(reportOutputKey(scope, 'pdf').startsWith(REPORTS_PREFIX)).toBe(true);
  });

  it('a run with no account uses the literal `tenant` segment, never the tenant id again', () => {
    expect(reportOutputPrefix({ ...scope, accountId: null })).toBe(`reports/${T}/tenant/${R}/`);
    expect(reportDatasetKey({ ...scope, accountId: null })).toBe(`report-datasets/${T}/tenant/${R}/dataset.json`);
  });

  it('writes ids in lower case, so one run has one set of keys', () => {
    expect(reportOutputKey({ tenantId: T.toUpperCase(), accountId: A.toUpperCase(), runId: R.toUpperCase() }, 'pdf'))
      .toBe(reportOutputKey(scope, 'pdf'));
  });

  it('refuses any id that is not a UUID', () => {
    const bad = ['', '..', '../../etc', `${T}/x`, `${T} `, 'tenant', '11111111111141118111111111111111', `${T.slice(0, -1)}g`];
    for (const value of bad) {
      expect(() => reportDatasetKey({ ...scope, tenantId: value }), value).toThrow(RangeError);
      expect(() => reportOutputKey({ ...scope, accountId: value }, 'pdf'), value).toThrow(RangeError);
      expect(() => reportDetailKey({ ...scope, runId: value }, 'calls'), value).toThrow(RangeError);
    }
    expect(() => reportDatasetKey({ ...scope, runId: undefined as unknown as string })).toThrow(RangeError);
    expect(() => reportDatasetKey({ ...scope, accountId: undefined as unknown as string })).toThrow(RangeError);
  });

  it('refuses an unknown sheet or format', () => {
    expect(() => reportDetailKey(scope, '../x' as never)).toThrow(RangeError);
    expect(() => reportOutputKey(scope, 'csv' as never)).toThrow(RangeError);
  });

  it('isReportOutputKey: exactly the run\'s key for that format, nothing else', () => {
    expect(isReportOutputKey(scope, 'pdf', `reports/${T}/${A}/${R}/report.pdf`)).toBe(true);
    expect(isReportOutputKey(scope, 'pdf', `reports/${T}/${A}/${R}/report.xlsx`)).toBe(false);
    expect(isReportOutputKey(scope, 'xlsx', `reports/${T}/${A}/${R}/../${R}/report.xlsx`)).toBe(false);
    expect(isReportOutputKey(scope, 'pdf', `reports/${T}/${A}/44444444-4444-4444-8444-444444444444/report.pdf`)).toBe(false);
    expect(isReportOutputKey(scope, 'pdf', 42)).toBe(false);
  });
});
