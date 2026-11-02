/**
 * VendorRateLimitBreaker: the analysis worker's shared pause after a vendor rate limit.
 * Pins: closed admits every slot; a rate limit opens it for the base pause and admits
 * nothing; rate limits from jobs that started before the opening neither reopen nor
 * escalate it; half-open admits one probe; a failed probe doubles the pause up to the
 * cap; only a completion that started after the opening closes it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  VendorRateLimitBreaker,
  BREAKER_BASE_PAUSE_MS,
  BREAKER_MAX_PAUSE_MS,
} from '../../../src/core/vendor-rate-limit-breaker.js';

function breaker() {
  let now = 1_000_000;
  const b = new VendorRateLimitBreaker({ now: () => now, random: () => 0.5 }); // no jitter
  return { b, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('VendorRateLimitBreaker', () => {
  it('closed admits every slot', () => {
    const { b } = breaker();
    expect(b.state).toBe('closed');
    expect(b.admit(8)).toBe(8);
    expect(b.reopensInMs()).toBe(0);
  });

  it('a rate limit opens it for the base pause; nothing is admitted until it ends', () => {
    const { b, advance, now } = breaker();
    const listener = vi.fn();
    b.onOpenListener(listener);
    const started = now();
    advance(10);
    expect(b.recordRateLimit(started)).toBe(BREAKER_BASE_PAUSE_MS / 1000);
    expect(listener).toHaveBeenCalledWith(BREAKER_BASE_PAUSE_MS, 1);
    expect(b.state).toBe('open');
    expect(b.admit(8)).toBe(0);
    advance(BREAKER_BASE_PAUSE_MS - 1);
    expect(b.admit(8)).toBe(0);
    advance(1);
    expect(b.state).toBe('half_open');
  });

  it('rate limits from jobs already in flight at the opening count once', () => {
    const { b, advance, now } = breaker();
    const listener = vi.fn();
    b.onOpenListener(listener);
    const startedBefore = now();
    advance(5);
    b.recordRateLimit(startedBefore);
    advance(BREAKER_BASE_PAUSE_MS); // even after the pause, a stale report does not escalate
    expect(b.recordRateLimit(startedBefore)).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(b.state).toBe('half_open');
  });

  it('half-open admits exactly one probe; a rate-limited probe doubles the pause, capped', () => {
    const { b, advance, now } = breaker();
    b.recordRateLimit(now());
    let pause = BREAKER_BASE_PAUSE_MS;
    for (let i = 0; i < 8; i++) {
      advance(pause);
      expect(b.admit(8)).toBe(1);
      b.onStarted(1);
      expect(b.admit(8)).toBe(0); // the probe is in flight
      const probeStart = now();
      advance(100);
      b.onFinished();
      const next = Math.min(pause * 2, BREAKER_MAX_PAUSE_MS);
      expect(b.recordRateLimit(probeStart)).toBe(next / 1000);
      pause = next;
    }
    expect(pause).toBe(BREAKER_MAX_PAUSE_MS);
  });

  it('only a completion that started after the opening closes it', () => {
    const { b, advance, now } = breaker();
    const old = now();
    advance(1);
    b.recordRateLimit(now());
    b.recordSuccess(old); // started before the opening: proves nothing
    expect(b.state).toBe('open');
    advance(BREAKER_BASE_PAUSE_MS);
    b.onStarted(1);
    const probe = now();
    b.onFinished();
    b.recordSuccess(probe);
    expect(b.state).toBe('closed');
    expect(b.admit(8)).toBe(8);
    // And the next opening starts from the base pause again.
    advance(1);
    expect(b.recordRateLimit(now())).toBe(BREAKER_BASE_PAUSE_MS / 1000);
  });

  describe('applyRemotePause (another analysis process was rate-limited, D10)', () => {
    it('pauses here until the remote end, escalating to the remote count, without telling the open listeners', () => {
      const { b, advance, now } = breaker();
      const opened = vi.fn();
      b.onOpenListener(opened);
      b.applyRemotePause(now() + 45_000, 2);
      expect(b.state).toBe('open');
      expect(b.admit(8)).toBe(0);
      expect(b.reopensInMs()).toBe(45_000);
      expect(opened).not.toHaveBeenCalled();
      advance(45_000);
      expect(b.state).toBe('half_open');
      // A local probe rate-limited now escalates from the remote count: the third opening.
      b.onStarted(1);
      b.recordRateLimit(now());
      expect(b.reopensInMs()).toBe(BREAKER_BASE_PAUSE_MS * 4);
      expect(opened).toHaveBeenCalledWith(BREAKER_BASE_PAUSE_MS * 4, 3);
    });

    it('never shortens a pause this process already holds, and ignores one already over', () => {
      const { b, now } = breaker();
      b.recordRateLimit(now()); // local: base pause
      b.applyRemotePause(now() + 1_000, 1);
      expect(b.reopensInMs()).toBe(BREAKER_BASE_PAUSE_MS);
      b.applyRemotePause(now() - 1, 5);
      expect(b.reopensInMs()).toBe(BREAKER_BASE_PAUSE_MS);
      b.applyRemotePause(now() + BREAKER_BASE_PAUSE_MS * 3, 2);
      expect(b.reopensInMs()).toBe(BREAKER_BASE_PAUSE_MS * 3);
    });

    it('a job already in flight here that comes back rate-limited does not reopen the remote pause', () => {
      const { b, advance, now } = breaker();
      const startedBefore = now();
      advance(10);
      b.applyRemotePause(now() + 20_000, 1);
      const left = b.reopensInMs();
      b.recordRateLimit(startedBefore);
      expect(b.reopensInMs()).toBe(left);
    });
  
    it('a job here that slipped into a remote pause and completes does not close it before its end', () => {
      const { b, advance, now } = breaker();
      b.applyRemotePause(now() + 30_000, 1);
      b.recordSuccess(now()); // a claim already on its way
      expect(b.state).toBe('open');
      advance(30_000);
      expect(b.state).toBe('half_open');
      b.onStarted(1);
      b.recordSuccess(now()); // the probe after the pause closes it
      expect(b.state).toBe('closed');
    });
  });
});

