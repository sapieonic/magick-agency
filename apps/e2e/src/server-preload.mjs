/**
 * Loaded into the server process with `node --import` for an e2e run (never in any other).
 *
 * Three vendor hosts are fixed in the server's code rather than configured: Plivo's REST API,
 * Mailjet, and the recording host (which must be https). This wraps `globalThis.fetch` so
 * requests to them go to the simulator instead.
 *
 * Every other request that would leave the machine is refused, by `fetch` and by
 * `http`/`https` `request` and `get` (the AWS SDK and firebase-admin use those), so an e2e run
 * cannot reach a real vendor even if a setting were missed. A raw socket (`net.connect`) is not
 * covered; nothing in the server opens one to a vendor.
 *
 * E2E_SIM_ORIGIN (http://127.0.0.1:<port>) is the simulator.
 */
const sim = process.env.E2E_SIM_ORIGIN;
if (!sim) throw new Error('server-preload: E2E_SIM_ORIGIN is not set');

/** host -> path prefix on the simulator */
const REDIRECTS = new Map([
  ['api.plivo.com', '/plivo'],
  ['api.mailjet.com', '/mailjet'],
  ['recording.e2e.invalid', '/recordings'],
]);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const realFetch = globalThis.fetch.bind(globalThis);

function target(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

globalThis.fetch = async function e2eFetch(input, init) {
  const href = target(input);
  let url;
  try { url = new URL(href); } catch { return realFetch(input, init); }
  const prefix = REDIRECTS.get(url.hostname);
  if (prefix) {
    const redirected = `${sim}${prefix}${url.pathname}${url.search}`;
    if (input instanceof Request) return realFetch(new Request(redirected, input), init);
    return realFetch(redirected, init);
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new TypeError(`e2e: refused a request to ${url.hostname} (only the simulator is reachable in an e2e run)`);
  }
  return realFetch(input, init);
};

// ── node:http / node:https ──
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

function requestHost(args) {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) {
    try { return new URL(String(first)).hostname; } catch { return undefined; }
  }
  const opts = first && typeof first === 'object' ? first : second;
  if (!opts || typeof opts !== 'object') return 'localhost';
  return opts.hostname ?? (typeof opts.host === 'string' ? opts.host.replace(/:\d+$/, '') : undefined) ?? 'localhost';
}

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    const real = mod[name];
    mod[name] = function e2eRequest(...args) {
      const host = requestHost(args);
      if (host !== undefined && !LOOPBACK.has(host)) {
        throw new Error(`e2e: refused a request to ${host} (only the simulator is reachable in an e2e run)`);
      }
      return real.apply(this, args);
    };
  }
}
// `import { request } from 'node:https'` reads the patched functions too.
syncBuiltinESMExports();
