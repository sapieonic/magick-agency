import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ─── Recordings for inbound routes through the real app and Postgres ──────────────────────
 *
 * `POST /proxy/agency/inbound/clips` and `DELETE /proxy/agency/inbound/clips/:id`
 * (docs/inbound.md §8.4): the session (Firebase stubbed), tenant context, RBAC, the flag, the
 * multipart upload, the real decoder (`mpg123`, `sndfile-programs`), `callCore`, the internal
 * handlers and the repositories on real Postgres, the audit rows; the bucket in memory.
 *
 * What it pins:
 *  1. an upload decodes and is checked BEFORE anything is stored: an undecodable file, a type
 *     we cannot play, an oversized one, no file at all leave no object and no row, each refused
 *     `inbound_clip_invalid` with its `upload_reason`;
 *  2. a good one is stored under a key of the tenant and account, recorded with its length and
 *     its clip cache hash (so the first call plays it from the cache), audited, listed, and plays
 *     through the route's clip lookup at once;
 *  3. a name the account already uses is refused and its object deleted again;
 *  4. no audio storage on the deployment: 503 `inbound_clip_storage_unavailable`, the list says so;
 *  5. delete: refused while a live route plays it (naming the routes), done once none does (the
 *     object removed, audited), another account's or a malformed id is not found;
 *  6. access: an agent cannot upload or delete; the flag off refuses.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'inbound-clips-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
/** The app's bucket, in memory. */
const bucket = vi.hoisted(() => ({ files: new Map<string, { body: Buffer; contentType: string }>(), configured: true }));
vi.mock('../../../src/storage/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/storage/s3.js')>();
  return {
    ...actual,
    isStorageConfigured: () => bucket.configured,
    uploadFile: async (key: string, body: Buffer, contentType: string) => { bucket.files.set(key, { body, contentType }); },
    deleteFile: async (key: string) => { bucket.files.delete(key); },
    getFile: async (key: string) => {
      const f = bucket.files.get(key);
      if (!f) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return f.body;
    },
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { resolveInboundClip } from '../../../src/agency/inbound/inbound-clips.js';
import { hashAudioFileContent, ttsFileExists } from '../../../src/tts/tts-file-cache.js';
import { callCore } from '../../../src/api/core-dispatch.js';

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);
const WAV = fs.readFileSync(path.resolve(__dirname, '../../../assets/inbound/please-hold.wav'));
const T_ACCOUNT_KEY = (tenant: string, account: string) => new RegExp(`^inbound-audio/${tenant}/${account}/[0-9a-f-]{36}\\.wav$`);

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
const sup = () => floor.supervisors[0]!;
const agent = () => floor.agents[0]!;

/** A multipart body: the fields in order, then the file (when given). */
function multipart(fields: Record<string, string>, file?: { name: string; type: string; body: Buffer }) {
  const boundary = `----inbound${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.body, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(actor: Actor, fields: Record<string, string>, file?: { name: string; type: string; body: Buffer }, f: TenantFloor = floor) {
  const body = multipart(fields, file);
  return loaded.app.inject({
    method: 'POST',
    url: '/proxy/agency/inbound/clips',
    headers: headersFor(actor, f, { 'content-type': body.contentType }),
    payload: body.payload,
  });
}

function call(method: 'GET' | 'POST' | 'DELETE', url: string, actor: Actor, body?: unknown, f: TenantFloor = floor) {
  return loaded.app.inject({
    method,
    url: `/proxy/agency/inbound${url}`,
    headers: headersFor(actor, f, body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function setFlag(tenant: string, on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1 AND scope_type = 'tenant'`, [tenant]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
           VALUES ('agency_inbound_enabled', 'tenant', $1, NULL, $2::jsonb)`, [tenant, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
}

async function audits(action: string, resourceId: string) {
  await drainAudits();
  const { rows } = await q(`SELECT user_id, account_id, details FROM platform_audit_log WHERE action = $1 AND resource_id = $2`, [action, resourceId]);
  return rows as Array<{ user_id: string; account_id: string; details: Record<string, unknown> }>;
}

const rowsOfAccount = async (tenant: string, account: string) =>
  (await q('SELECT id, name, s3_key FROM audio_files WHERE tenant_id = $1 AND account_id = $2', [tenant, account])).rows;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = (await seedFloor({ tenants: 2, agentsPerTenant: 1, supervisorsPerTenant: 1, campaignsPerTenant: 1 })) as [TenantFloor, TenantFloor];
  for (const f of [floor, other]) await setFlag(f.tenant, true);
});

beforeEach(async () => {
  bucket.files.clear();
  bucket.configured = true;
  await q('DELETE FROM agency_inbound_routes');
  await q('DELETE FROM audio_files');
});

afterAll(async () => {
  await truncateAll();
  await stopLoadApp(loaded);
});

describe('upload', () => {
  it('a WAV that decodes: stored under the account’s key, recorded with its length and cache hash, audited, listed, and playable at once', async () => {
    const res = await upload(sup(), { name: 'Please hold' }, { name: 'hold.wav', type: 'audio/wav', body: WAV });
    expect(res.statusCode, res.body).toBe(201);
    const clip = res.json().clip;
    expect(clip).toEqual({ id: expect.any(String), name: 'Please hold', duration_seconds: expect.any(Number), created_at: expect.any(String), routes: [] });
    expect(clip.duration_seconds).toBeGreaterThan(4);

    const { rows: [row] } = await q('SELECT * FROM audio_files WHERE id = $1', [clip.id]);
    expect(row).toMatchObject({
      tenant_id: floor.tenant, account_id: floor.account, name: 'Please hold', slug: 'please-hold', original_filename: 'hold.wav',
      content_type: 'audio/wav', size_bytes: String(WAV.length), pcm_audio_hash: hashAudioFileContent(WAV), pcm_sample_rate: 8000, pcm_channels: 1,
    });
    expect(row.s3_key).toMatch(T_ACCOUNT_KEY(floor.tenant, floor.account));
    expect(bucket.files.get(row.s3_key)).toEqual({ body: WAV, contentType: 'audio/wav' });
    expect(ttsFileExists(row.pcm_audio_hash)).toBe(true);

    const [audit] = await audits('agency_inbound_clip.uploaded', clip.id);
    expect(audit).toMatchObject({ user_id: sup().id, account_id: floor.account, details: { size_bytes: WAV.length, duration_seconds: clip.duration_seconds } });

    const list = (await call('GET', '/clips', sup())).json();
    expect(list).toMatchObject({ upload_available: true, connects_agents: true });
    expect(list.clips.map((c: { id: string }) => c.id)).toEqual([clip.id]);
    // The route's clip lookup plays it, from the cache.
    expect(await resolveInboundClip(clip.id, { tenantId: floor.tenant, accountId: floor.account })).toBe(row.pcm_audio_hash);
  });

  it('named from the file when no name is given', async () => {
    const res = await upload(sup(), {}, { name: 'Main greeting.wav', type: 'audio/x-wav', body: WAV });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().clip.name).toBe('Main greeting');
  });

  it('refuses before storing anything: undecodable, a type we cannot play, too large, no file', async () => {
    const cases: Array<[string, Parameters<typeof upload>[2], number, string]> = [
      ['undecodable', { name: 'x.mp3', type: 'audio/mpeg', body: Buffer.from('not audio, only words '.repeat(50)) }, 400, 'undecodable'],
      ['a text file', { name: 'notes.txt', type: 'text/plain', body: WAV }, 400, 'unsupported_type'],
      ['too large', { name: 'big.wav', type: 'audio/wav', body: Buffer.alloc(5 * 1024 * 1024 + 10) }, 413, 'too_large'],
      ['no file', undefined, 400, 'no_file'],
    ];
    for (const [what, file, status, reason] of cases) {
      const res = await upload(sup(), { name: 'Bad' }, file);
      expect(res.statusCode, `${what}: ${res.body}`).toBe(status);
      expect(res.json(), what).toMatchObject({ code: 'inbound_clip_invalid', upload_reason: reason, message: expect.any(String) });
    }
    expect(bucket.files.size).toBe(0);
    expect(await rowsOfAccount(floor.tenant, floor.account)).toEqual([]);
    // A JSON body is no upload either.
    const json = await call('POST', '/clips', sup(), { name: 'x' });
    expect(json.json()).toMatchObject({ code: 'inbound_clip_invalid', upload_reason: 'no_file' });
  });

  it('a name the account already uses is refused, and the object stored for it is deleted again', async () => {
    expect((await upload(sup(), { name: 'Hold' }, { name: 'a.wav', type: 'audio/wav', body: WAV })).statusCode).toBe(201);
    const res = await upload(sup(), { name: 'Hold' }, { name: 'b.wav', type: 'audio/wav', body: WAV });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'inbound_clip_name_taken' });
    expect(bucket.files.size).toBe(1);
    // Another account may use the name.
    expect((await upload(other.supervisors[0]!, { name: 'Hold' }, { name: 'a.wav', type: 'audio/wav', body: WAV }, other)).statusCode).toBe(201);
  });

  it('no audio storage on the deployment: 503, nothing stored, and the list says uploads are unavailable', async () => {
    bucket.configured = false;
    const res = await upload(sup(), { name: 'Hold' }, { name: 'a.wav', type: 'audio/wav', body: WAV });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'inbound_clip_storage_unavailable' });
    expect(await rowsOfAccount(floor.tenant, floor.account)).toEqual([]);
    expect((await call('GET', '/clips', sup())).json().upload_available).toBe(false);
  });
});

describe('the internal handler records only a key of the request’s own tenant and account', () => {
  it('another account’s key, or one of another shape, is refused and nothing is written', async () => {
    const body = (key: string) => ({
      name: 'Forged', slug: 'forged', original_filename: 'f.wav', content_type: 'audio/wav', size_bytes: 10,
      s3_key: key, duration_seconds: 2, pcm_audio_hash: 'a'.repeat(40), pcm_sample_rate: 8000,
    });
    const record = (key: string) => callCore({
      method: 'POST', path: '/agency/inbound/clips', query: { actor_user_id: sup().id }, body: body(key),
      tenantId: floor.tenant, accountId: floor.account,
    });
    for (const key of [
      `inbound-audio/${other.tenant}/${other.account}/${randomUUID()}.wav`,
      `inbound-audio/${floor.tenant}/${other.account}/${randomUUID()}.wav`,
      `inbound-voicemail/${floor.tenant}/${floor.account}/${randomUUID()}.wav`,
      `inbound-audio/${floor.tenant}/${floor.account}/../x.wav`,
    ]) {
      const res = await record(key);
      expect(res.status, key).toBe(400);
      expect(res.body, key).toMatchObject({ code: 'invalid_recording' });
    }
    expect(await rowsOfAccount(floor.tenant, floor.account)).toEqual([]);
    // Its own key is recorded.
    const ok = await record(`inbound-audio/${floor.tenant}/${floor.account}/${randomUUID()}.wav`);
    expect(ok.status).toBe(201);
  });
});

describe('delete', () => {
  it('refused while a live route plays it, naming the route; done once none does: row and object gone, audited', async () => {
    const clip = (await upload(sup(), { name: 'Greeting' }, { name: 'g.wav', type: 'audio/wav', body: WAV })).json().clip;
    const route = await call('POST', '/routes', sup(), { name: 'Main line', timezone: 'Europe/London', clips: { greeting: clip.id } });
    expect(route.statusCode, route.body).toBe(201);
    const routeId = route.json().route.id;
    expect((await call('GET', '/clips', sup())).json().clips[0].routes).toEqual([{ route_id: routeId, name: 'Main line' }]);

    const refused = await call('DELETE', `/clips/${clip.id}`, sup());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'inbound_clip_in_use', routes: [{ route_id: routeId, name: 'Main line' }] });
    expect(bucket.files.size).toBe(1);

    expect((await call('DELETE', `/routes/${routeId}`, sup())).statusCode).toBe(204);
    const done = await call('DELETE', `/clips/${clip.id}`, sup());
    expect(done.statusCode, done.body).toBe(204);
    expect(await rowsOfAccount(floor.tenant, floor.account)).toEqual([]);
    expect(bucket.files.size).toBe(0);
    expect(await audits('agency_inbound_clip.deleted', clip.id)).toHaveLength(1);
    expect((await call('DELETE', `/clips/${clip.id}`, sup())).json()).toMatchObject({ code: 'inbound_clip_not_found' });
  });

  it('an active announcement using it holds it too', async () => {
    const clip = (await upload(sup(), { name: 'Sorry' }, { name: 's.wav', type: 'audio/wav', body: WAV })).json().clip;
    await q(`INSERT INTO announcements (tenant_id, account_id, name, type, audio_file_id, is_active) VALUES ($1, $2, 'Abandon', 'audio', $3, true)`,
      [floor.tenant, floor.account, clip.id]);
    const res = await call('DELETE', `/clips/${clip.id}`, sup());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'inbound_clip_in_use', routes: [] });
    await q('DELETE FROM announcements');
  });

  it('another account’s recording, or a malformed id, is not found', async () => {
    const theirs = (await upload(other.supervisors[0]!, { name: 'Theirs' }, { name: 't.wav', type: 'audio/wav', body: WAV }, other)).json().clip;
    expect((await call('DELETE', `/clips/${theirs.id}`, sup())).json()).toMatchObject({ code: 'inbound_clip_not_found' });
    expect(await rowsOfAccount(other.tenant, other.account)).toHaveLength(1);
    const bad = await call('DELETE', '/clips/not-a-uuid', sup());
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toMatchObject({ code: 'inbound_clip_not_found' });
  });
});

describe('access', () => {
  it('an agent cannot upload or delete; the flag off refuses everyone', async () => {
    const clip = (await upload(sup(), { name: 'Mine' }, { name: 'm.wav', type: 'audio/wav', body: WAV })).json().clip;
    const byAgent = await upload(agent(), { name: 'Agent' }, { name: 'a.wav', type: 'audio/wav', body: WAV });
    expect(byAgent.statusCode).toBe(403);
    expect((await call('DELETE', `/clips/${clip.id}`, agent())).statusCode).toBe(403);
    await setFlag(floor.tenant, false);
    try {
      const res = await upload(sup(), { name: 'Off' }, { name: 'o.wav', type: 'audio/wav', body: WAV });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'inbound_disabled' });
      expect((await call('DELETE', `/clips/${clip.id}`, sup())).json()).toMatchObject({ code: 'inbound_disabled' });
    } finally {
      await setFlag(floor.tenant, true);
    }
    expect(await rowsOfAccount(floor.tenant, floor.account)).toHaveLength(1);
  });
});
