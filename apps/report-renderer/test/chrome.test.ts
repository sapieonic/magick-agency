import { describe, expect, it } from 'vitest';
import { findChrome, type ChromeDiscoveryDeps } from '../src/pdf/chrome';

function deps(files: string[], env: Record<string, string> = {}, dirs: Record<string, string[]> = {}): ChromeDiscoveryDeps {
  return { env, exists: (p) => files.includes(p), list: (d) => dirs[d] ?? [] };
}

describe('findChrome', () => {
  it('prefers AGENCY_REPORTS_CHROME_PATH, then CHROME_PATH, skipping paths that do not exist', () => {
    expect(findChrome(deps(['/a', '/b'], { AGENCY_REPORTS_CHROME_PATH: '/a', CHROME_PATH: '/b' }))).toBe('/a');
    expect(findChrome(deps(['/b'], { AGENCY_REPORTS_CHROME_PATH: '/missing', CHROME_PATH: '/b' }))).toBe('/b');
  });

  it('then the newest Playwright Chromium, then the system paths', () => {
    const pw = {
      '/opt/pw-browsers': ['chromium-1200', 'chromium-1243', 'chromium_headless_shell-1243', 'ffmpeg-1011'],
      '/opt/pw-browsers/chromium-1243': ['chrome-linux64'],
      '/opt/pw-browsers/chromium-1200': ['chrome-linux'],
    };
    expect(findChrome(deps(['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium-1200/chrome-linux/chrome', '/usr/bin/google-chrome'], {}, pw))).toBe(
      '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    );
    expect(findChrome(deps(['/usr/bin/chromium', '/usr/bin/google-chrome']))).toBe('/usr/bin/google-chrome');
    expect(findChrome(deps(['/usr/bin/chromium-browser']))).toBe('/usr/bin/chromium-browser');
    expect(findChrome(deps([]))).toBeNull();
  });
});
