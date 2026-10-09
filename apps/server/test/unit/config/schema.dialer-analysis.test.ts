import { describe, expect, it } from 'vitest';
import type { ZodObject } from 'zod';
import { appConfigSchema } from '../../../src/config/schema.js';

const dialerOptional = appConfigSchema.shape.dialerAnalysis;
const dialerSchema = dialerOptional.unwrap() as unknown as ZodObject<any>;
const retentionSchema = appConfigSchema.shape.retention as unknown as ZodObject<any>;

describe('dialerAnalysis configuration schema', () => {
  it('leaves the block optional so a deploy without DIALER_ANALYSIS_ENABLED parses', () => {
    expect(dialerOptional.parse(undefined)).toBeUndefined();
  });

  it('uses the documented safe defaults', () => {
    const parsed = dialerSchema.parse({});
    expect(parsed).toMatchObject({
      enabled: false,
      transcriber: 'gemini',
      settleSeconds: 15,
      recordingFetchRetries: 2,
      recordingFetchRetryDelaySeconds: 15,
      maxAttempts: 3,
      maxAttemptsTotal: 8,
      concurrency: 2,
      minTalkTimeSeconds: 10,
      recordingWaitMinutes: 30,
    });
  });

  it('parses the string false as false rather than the z.coerce.boolean trap', () => {
    expect(dialerSchema.parse({ enabled: 'false' }).enabled).toBe(false);
    expect(dialerSchema.parse({ enabled: '0' }).enabled).toBe(false);
  });

  it('rejects invalid transcribers and numeric bounds', () => {
    expect(dialerSchema.safeParse({ transcriber: 'whisper' }).success).toBe(false);
    expect(dialerSchema.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(dialerSchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(dialerSchema.safeParse({ maxAttemptsTotal: 0 }).success).toBe(false);
    expect(dialerSchema.safeParse({ recordingWaitMinutes: 0 }).success).toBe(false);
    expect(dialerSchema.safeParse({ recordingFetchRetries: 11 }).success).toBe(false);
    expect(dialerSchema.safeParse({ settleSeconds: -1 }).success).toBe(false);
  });

  // The agency transcript window defaults to 30 days (`.default(30)`).
  it('defaults transcript retention to thirty days', () => {
    expect((retentionSchema.parse({}) as { agencyTranscriptRetentionDays?: number }).agencyTranscriptRetentionDays).toBe(30);
  });
});

/**
 * `AGENCY_RETENTION_DAYS` deletes rows. `POST /internal/maintenance/retention-purge`
 * already refuses `retention_days < RETENTION_MIN_DAYS` with a 422, and without
 * this floor the identical mistake was accepted from the environment — on the one
 * population that has its own window because somebody's contract sets the term.
 *
 * Refused at boot rather than clamped: the platform exits on invalid config, and a
 * clamp would silently run 30 days for an operator who typed 4 meaning 400.
 */
describe('agency retention windows are floored by RETENTION_MIN_DAYS', () => {
  it('refuses an agency row window below the floor', () => {
    // 4 is the plausible typo — for 40, or for 400.
    const result = retentionSchema.safeParse({ agencyRetentionDays: 4 });
    expect(result.success).toBe(false);
  });

  it('names the env var and the floor, so the exit message is actionable', () => {
    const result = retentionSchema.safeParse({ agencyRetentionDays: 4 });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain('AGENCY_RETENTION_DAYS');
    expect(message).toContain('RETENTION_MIN_DAYS');
  });

  it('accepts exactly the floor, and anything above it', () => {
    expect(retentionSchema.safeParse({ agencyRetentionDays: 30 }).success).toBe(true);
    expect(retentionSchema.safeParse({ agencyRetentionDays: 400 }).success).toBe(true);
  });

  it('floors against the CONFIGURED minimum, not a hardcoded 30', () => {
    // An operator who raised RETENTION_MIN_DAYS raised this floor with it; a
    // literal 30 here would let 45 through under a 60-day minimum.
    expect(retentionSchema.safeParse({ minDays: 60, agencyRetentionDays: 45 }).success).toBe(false);
    expect(retentionSchema.safeParse({ minDays: 60, agencyRetentionDays: 60 }).success).toBe(true);
    // And a LOWERED minimum lowers it too — the floor is the operator's, not ours.
    expect(retentionSchema.safeParse({ minDays: 7, agencyRetentionDays: 10 }).success).toBe(true);
  });

  // The ROW window stays unset (deleting call records is not a safe default); the
  // transcript window defaults to 30 and is not floored (below).
  it('leaves the row window unset by default, so nothing is floored into existence', () => {
    // Narrowed locally: `retentionSchema` above is cast to a loose `ZodObject`, so
    // its parse result carries no property types.
    const parsed = retentionSchema.parse({}) as {
      agencyRetentionDays?: number;
      agencyTranscriptRetentionDays?: number;
    };
    expect(parsed.agencyRetentionDays).toBeUndefined();
    expect(parsed.agencyTranscriptRetentionDays).toBe(30);
  });

  /**
   * The asymmetry is deliberate, and pinned here so it reads as a decision rather
   * than an omission. The transcript window exists to hold the full
   * transcript for LESS time than the row that carries it, because the transcript
   * is the liability — so a small value there is the conservative direction. It
   * also mirrors `transcriptRetentionDays`, which has never been floored; flooring
   * one of the pair and not the other would make `DIALER_TRANSCRIPT_RETENTION_DAYS=7`
   * legal and `AGENCY_TRANSCRIPT_RETENTION_DAYS=7` a boot failure.
   */
  it('does NOT floor either transcript window, which is the point of a short one', () => {
    expect(retentionSchema.safeParse({ agencyTranscriptRetentionDays: 7 }).success).toBe(true);
    // Still a positive integer, though — zero or negative is a mistake either way.
    expect(retentionSchema.safeParse({ agencyTranscriptRetentionDays: 0 }).success).toBe(false);
  });
});
