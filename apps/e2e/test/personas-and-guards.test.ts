/** The persona table, the mailbox, the preload's egress guard and the run's target guards. */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2E_ROOT } from '../src/env.js';
import { normaliseNumber, personaFor, type Persona } from '../src/sim/voicelink.js';
import { Mailbox } from '../src/sim/vendors.js';

describe('personas', () => {
  it('pick the outcome from the last two digits of the national number', () => {
    const none = new Map<string, Persona>();
    expect(personaFor('9876500101', none).name).toBe('answer');
    expect(personaFor('+91 98765 00102', none).name).toBe('busy');
    expect(personaFor('919876500103', none).name).toBe('no_answer');
    expect(personaFor('9876500104', none).name).toBe('failed');
    expect(personaFor('9876500105', none).name).toBe('answer_then_hangup');
    expect(personaFor('9876500199', none).name).toBe('answer');
  });

  it('let an override win for that number only', () => {
    const o = new Map<string, Persona>([[normaliseNumber('+919876500101'), { name: 'busy' }]]);
    expect(personaFor('9876500101', o).name).toBe('busy');
    expect(personaFor('9876500201', o).name).toBe('answer');
  });
});

describe('mailbox', () => {
  it('records Mailjet sends by recipient', () => {
    const box = new Mailbox();
    const res = { writeHead: () => res, end: () => res } as never;
    box.handleSend(JSON.stringify({ Messages: [{ To: [{ Email: 'A@x.test' }], Subject: 'Hi', TextPart: 'link http://localhost/join/abc' }] }), res);
    expect(box.to('a@x.test')).toHaveLength(1);
    expect(box.to('a@x.test')[0]!.text).toContain('/join/abc');
  });
});

describe('server preload', () => {
  const run = (code: string) =>
    spawnSync(process.execPath, ['--import', join(E2E_ROOT, 'src', 'server-preload.mjs'), '--input-type=module', '-e', code], {
      env: { ...process.env, E2E_SIM_ORIGIN: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });

  it('refuses a request to any host but loopback and the redirected vendors', () => {
    const r = run(`try { await fetch('https://api.openai.com/v1/models'); console.log('REACHED'); } catch (e) { console.log(String(e.message)); }`);
    expect(r.stdout).toContain('refused a request to api.openai.com');
    expect(r.stdout).not.toContain('REACHED');
  });

  it('sends Mailjet, Plivo and the recording host to the simulator', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => { seen.push(req.url ?? ''); res.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const code = `for (const u of ['https://api.mailjet.com/v3.1/send', 'https://api.plivo.com/v1/Account/X/Call/', 'https://recording.e2e.invalid/a.wav']) console.log((await fetch(u)).status);`;
      const child = spawn(process.execPath, ['--import', join(E2E_ROOT, 'src', 'server-preload.mjs'), '--input-type=module', '-e', code], {
        env: { ...process.env, E2E_SIM_ORIGIN: origin },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      await new Promise((r) => child.on('exit', r));
      expect(out.trim().split('\n')).toEqual(['200', '200', '200']);
      expect(seen).toEqual(['/mailjet/v3.1/send', '/plivo/v1/Account/X/Call/', '/recordings/a.wav']);
    } finally {
      server.close();
    }
  });
});

describe('target guards', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const guard = async () => {
    vi.resetModules();
    const mod = await import('../src/env.js');
    return () => mod.assertSafeTargets();
  };

  it('accept the defaults', async () => {
    expect(await guard()).not.toThrow();
  });
  it('refuse a database that is not an e2e one', async () => {
    process.env['E2E_DB_NAME'] = 'magick_agency';
    expect(await guard()).toThrow(/magick_agency_e2e/);
  });
  it('refuse the dev and integration Redis dbs and other stacks\' ports', async () => {
    process.env['E2E_REDIS_DB'] = '3';
    expect(await guard()).toThrow(/Redis db 3/);
    process.env['E2E_REDIS_DB'] = '15';
    process.env['E2E_PG_PORT'] = '5432';
    expect(await guard()).toThrow(/5432/);
  });
});
