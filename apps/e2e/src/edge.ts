/**
 * The edge: what nginx is in production (`docker/nginx.conf`), for the e2e run. It serves the
 * BUILT console and super-admin (`dist/`, SPA fallback) on their own ports and proxies the API
 * prefixes, WebSocket upgrades included, to the server, adding one X-Forwarded-For hop
 * (`TRUST_PROXY_HOPS=1`, as deployed).
 *
 * The Vite dev servers are not used: their proxy targets are fixed at :3021, and the production
 * bundles are what ships.
 */
import http from 'node:http';
import net from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

/** The console's API prefixes, exactly nginx's. */
const CONSOLE_API = /^\/(auth|accounts|tenants|users|invites|notifications|feature-flags|client-config|proxy|dnc|phone-numbers|api|webhooks)(\/|$)|^\/(healthz|readyz)$/;
const SUPER_ADMIN_API = /^\/super-admin\//;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export interface EdgeSite {
  port: number;
  root: string;
  api: RegExp;
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (`/%E0%A4%A`): answered, never thrown out of the request listener, which
    // would take the whole orchestrator (simulator included) down with it.
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('edge: bad path');
    return;
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function proxyHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const xff = req.headers['x-forwarded-for'];
  return {
    ...req.headers,
    'x-forwarded-for': xff ? `${String(xff)}, ${req.socket.remoteAddress ?? '127.0.0.1'}` : (req.socket.remoteAddress ?? '127.0.0.1'),
    'x-forwarded-proto': 'http',
  };
}

export async function startEdge(sites: EdgeSite[], upstream: { host: string; port: number }): Promise<() => Promise<void>> {
  const servers: http.Server[] = [];
  const sockets = new Set<net.Socket>();
  for (const site of sites) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://edge.local');
      if (!site.api.test(url.pathname)) return serveStatic(site.root, url.pathname, res);
      const up = http.request(
        { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: proxyHeaders(req) },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`edge: upstream error ${err.message}`);
      });
      req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://edge.local');
      if (!site.api.test(url.pathname)) return socket.destroy();
      const up = net.connect(upstream.port, upstream.host, () => {
        const headers = proxyHeaders(req);
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
        }
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      const kill = () => { up.destroy(); socket.destroy(); };
      up.on('error', kill);
      socket.on('error', kill);
      up.on('close', () => socket.destroy());
      socket.on('close', () => up.destroy());
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(site.port, '127.0.0.1', () => resolve());
    });
    servers.push(server);
  }
  return async () => {
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  };
}

export { CONSOLE_API, SUPER_ADMIN_API };
