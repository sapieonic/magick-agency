import { describe, it, expect, afterEach } from 'vitest';
import { browserStorage } from '../../utils/browserStorage';

describe('browserStorage', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  afterEach(() => Object.defineProperty(window, 'localStorage', real));

  it('is the window’s localStorage', () => {
    expect(browserStorage()).toBe(window.localStorage);
  });

  it('is undefined where reading it throws (blocked site data)', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(browserStorage()).toBeUndefined();
  });
});
