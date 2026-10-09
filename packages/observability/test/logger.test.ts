import { describe, expect, it } from 'vitest';
import { createChildLogger, logger, SERVICE_NAME, APP_VERSION } from '../src/index.js';
import { maskPhone } from '../src/crypto.js';

describe('observability', () => {
  it('exposes the logger API', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof createChildLogger({ component: 'x' }).warn).toBe('function');
  });

  it('names the service magick-agency (Grafana routes on service_name)', () => {
    expect(SERVICE_NAME).toBe('magick-agency');
  });

  it('falls back to the version sentinel outside a build', () => {
    expect(APP_VERSION).toBe('0.0.0');
  });

  it('carries PII masking', () => {
    expect(maskPhone('+919876543210')).not.toContain('98765');
  });
});
