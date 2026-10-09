import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDialerAnalysisWorker,
  setDialerAnalysisWorker,
} from '../../../src/core/dialer-analysis-worker-handle.js';

afterEach(() => setDialerAnalysisWorker(null));

describe('dialer-analysis-worker handle', () => {
  it('is null before a worker is registered', () => {
    setDialerAnalysisWorker(null);
    expect(getDialerAnalysisWorker()).toBeNull();
  });

  it('returns the worker set by startup wiring', () => {
    const worker = { wake: vi.fn() };
    setDialerAnalysisWorker(worker);
    expect(getDialerAnalysisWorker()).toBe(worker);
    getDialerAnalysisWorker()?.wake();
    expect(worker.wake).toHaveBeenCalledOnce();
  });

  it('clears the handle with null and remains optional-chain safe when unset', () => {
    setDialerAnalysisWorker({ wake: vi.fn() });
    setDialerAnalysisWorker(null);
    expect(() => getDialerAnalysisWorker()?.wake()).not.toThrow();
    expect(getDialerAnalysisWorker()).toBeNull();
  });
});
