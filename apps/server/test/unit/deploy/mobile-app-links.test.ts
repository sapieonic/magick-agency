import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `docker/mobile-app-links.sh`: the Universal Links / App Links files the web container
 * writes at start from MOBILE_* env, and `docker/nginx.conf`'s two exact locations that serve
 * them. The script runs here under `sh` with sample env into a temporary directory
 * (`MOBILE_APP_LINKS_DIR`), and its JSON is parsed:
 *  - the AASA lists every iOS app ID and covers ONLY `/agency/join/*`;
 *  - assetlinks.json carries the package (default `com.magickagency.agent`) and every
 *    fingerprint, normalised to `AA:BB:…` upper case;
 *  - a file whose env is unset, empty or invalid is not written, and a stale one from an
 *    earlier start is removed (nginx then 404s), and the script never fails the container.
 */

const DOCKER = fileURLToPath(new URL('../../../../../docker/', import.meta.url));
const SCRIPT = join(DOCKER, 'mobile-app-links.sh');
const NGINX = readFileSync(join(DOCKER, 'nginx.conf'), 'utf8');
const WEB_DOCKERFILE = readFileSync(join(DOCKER, 'web.Dockerfile'), 'utf8');
const COMPOSE = readFileSync(join(DOCKER, 'docker-compose.prod.yml'), 'utf8');

const FP_A = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const FP_B_RAW = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const FP_B = 'FE:DC:BA:98:76:54:32:10:FE:DC:BA:98:76:54:32:10:FE:DC:BA:98:76:54:32:10:FE:DC:BA:98:76:54:32:10';

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'app-links-'));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

/** Runs the script with ONLY these MOBILE_* variables set; returns its stderr log. */
function run(env: Record<string, string>): string {
  const result = execFileSync('sh', [SCRIPT], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', MOBILE_APP_LINKS_DIR: out, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result;
}

const aasaPath = () => join(out, 'apple-app-site-association');
const assetlinksPath = () => join(out, 'assetlinks.json');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('docker/mobile-app-links.sh', () => {
  it('writes the AASA for every app ID, covering only /agency/join/*', () => {
    run({ MOBILE_IOS_APP_IDS: 'ABCDE12345.com.magickagency.agent, ABCDE12345.com.magickagency.agent.staging' });
    expect(readJson(aasaPath())).toEqual({
      applinks: {
        details: [{
          appIDs: ['ABCDE12345.com.magickagency.agent', 'ABCDE12345.com.magickagency.agent.staging'],
          components: [{ '/': '/agency/join/*', comment: 'Agent invite links' }],
        }],
      },
    });
  });

  it('writes assetlinks.json with the default package and normalised fingerprints', () => {
    run({ MOBILE_ANDROID_CERT_SHA256: ` ${FP_A.toLowerCase()} ,${FP_B_RAW}` });
    expect(readJson(assetlinksPath())).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.magickagency.agent',
        sha256_cert_fingerprints: [FP_A, FP_B],
      },
    }]);
  });

  it('takes MOBILE_ANDROID_PACKAGE', () => {
    run({ MOBILE_ANDROID_CERT_SHA256: FP_A, MOBILE_ANDROID_PACKAGE: 'com.example.agent_beta' });
    expect((readJson(assetlinksPath()) as Array<{ target: { package_name: string } }>)[0]!.target.package_name)
      .toBe('com.example.agent_beta');
  });

  it('writes neither file when nothing is set, and the script still succeeds', () => {
    const log = run({});
    expect(existsSync(aasaPath())).toBe(false);
    expect(existsSync(assetlinksPath())).toBe(false);
    expect(log).toBe('');
  });

  it('treats an empty value as unset (compose passes ${VAR:-})', () => {
    run({ MOBILE_IOS_APP_IDS: '', MOBILE_ANDROID_CERT_SHA256: '' });
    expect(existsSync(aasaPath())).toBe(false);
    expect(existsSync(assetlinksPath())).toBe(false);
  });

  it.each([
    ['a team ID that is not 10 characters', { MOBILE_IOS_APP_IDS: 'ABC.com.magickagency.agent' }, 'aasa'],
    ['a bare bundle ID', { MOBILE_IOS_APP_IDS: 'com.magickagency.agent' }, 'aasa'],
    ['one good ID and one with a quote', { MOBILE_IOS_APP_IDS: 'ABCDE12345.com.a.b,ABCDE12345.com."x' }, 'aasa'],
    ['a short fingerprint', { MOBILE_ANDROID_CERT_SHA256: 'AB:CD:EF' }, 'assetlinks'],
    ['a fingerprint with a non-hex digit', { MOBILE_ANDROID_CERT_SHA256: FP_A.replace('AB', 'ZZ') }, 'assetlinks'],
    ['a SHA-1 fingerprint', { MOBILE_ANDROID_CERT_SHA256: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01' }, 'assetlinks'],
    ['a package name with a quote', { MOBILE_ANDROID_CERT_SHA256: FP_A, MOBILE_ANDROID_PACKAGE: 'com.x"y' }, 'assetlinks'],
  ] as const)('writes no file for %s', (_label, env, file) => {
    run(env as Record<string, string>);
    expect(existsSync(file === 'aasa' ? aasaPath() : assetlinksPath())).toBe(false);
  });

  it('removes a stale file when its variable is no longer set', () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(aasaPath(), '{"stale":true}');
    writeFileSync(assetlinksPath(), '[]');
    run({});
    expect(existsSync(aasaPath())).toBe(false);
    expect(existsSync(assetlinksPath())).toBe(false);
  });

  it('is executable in the repository and installed into the nginx entrypoint directory', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect(WEB_DOCKERFILE).toMatch(/^COPY docker\/mobile-app-links\.sh \/docker-entrypoint\.d\/\d+-mobile-app-links\.sh$/m);
    expect(WEB_DOCKERFILE).toMatch(/^RUN chmod 0755 \/docker-entrypoint\.d\/\d+-mobile-app-links\.sh$/m);
    // The web container gets the variables (it has no env_file of its own).
    for (const name of ['MOBILE_IOS_APP_IDS', 'MOBILE_ANDROID_PACKAGE', 'MOBILE_ANDROID_CERT_SHA256']) {
      expect(COMPOSE).toMatch(new RegExp(`^ {6}${name}: \\$\\{${name}:-`, 'm'));
    }
  });
});

describe('docker/nginx.conf serves them', () => {
  /** The body of the exact-match location for `path` on the console block. */
  function exactLocation(path: string): string {
    const escaped = path.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    const match = NGINX.match(new RegExp(`location = ${escaped} \\{([^}]*)\\}`));
    expect(match, `no exact location for ${path}`).not.toBeNull();
    return match?.[1] ?? '';
  }

  it.each(['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json'])(
    '%s: from the generated directory, as JSON, 404 when absent, never proxied or redirected',
    (path) => {
      const body = exactLocation(path);
      expect(body).toMatch(/root \/usr\/share\/nginx\/app-links;/);
      expect(body).toMatch(/default_type application\/json;/);
      expect(body).toMatch(/try_files \$uri =404;/);
      expect(body).not.toMatch(/proxy_pass|return 30|rewrite|index\.html/);
    },
  );

  it('the script writes where nginx reads by default', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/MOBILE_APP_LINKS_DIR:-\/usr\/share\/nginx\/app-links\/\.well-known/);
  });
});
