/**
 * The fake identity service against the real SDK on the server side: a token it issues for a
 * password sign-in is accepted by firebase-admin in emulator mode (which also looks the user up
 * on the emulator host), and a token for an unknown user is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Simulator } from '../src/sim/index.js';

const PROJECT = 'demo-e2e-selftest';
let sim: Simulator;

beforeAll(async () => {
  sim = new Simulator({ port: 0, projectId: PROJECT, voicelink: { username: 'u', password: 'p' }, serverOrigin: 'http://127.0.0.1:1' });
  await sim.start();
  process.env['FIREBASE_AUTH_EMULATOR_HOST'] = sim.origin.replace('http://', '');
});
afterAll(async () => {
  delete process.env['FIREBASE_AUTH_EMULATOR_HOST'];
  await sim.stop();
});

async function rest(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${sim.origin}/identitytoolkit.googleapis.com/v1/${path}?key=k`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe('fake Firebase Auth', () => {
  it('signs up, signs in and refuses a wrong password', async () => {
    const up = await rest('accounts:signUp', { email: 'Ana@E2E.test', password: 'secret-123', returnSecureToken: true });
    expect(up.status).toBe(200);
    expect(up.json['email']).toBe('ana@e2e.test');
    const ok = await rest('accounts:signInWithPassword', { email: 'ana@e2e.test', password: 'secret-123' });
    expect(ok.status).toBe(200);
    expect(typeof ok.json['idToken']).toBe('string');
    const bad = await rest('accounts:signInWithPassword', { email: 'ana@e2e.test', password: 'nope' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain('INVALID_PASSWORD');
  });

  it("issues tokens firebase-admin's emulator mode verifies", async () => {
    const { initializeApp, deleteApp } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = initializeApp({ projectId: PROJECT }, 'selftest');
    try {
      const signIn = await rest('accounts:signUp', { email: 'verify@e2e.test', password: 'secret-123' });
      const decoded = await getAuth(app).verifyIdToken(String(signIn.json['idToken']));
      expect(decoded.email).toBe('verify@e2e.test');
      expect(decoded.email_verified).toBe(true);
      expect(decoded.uid).toBe(signIn.json['localId']);

      // A token naming a user the service never had fails the emulator-mode lookup.
      const forged = sim.firebase.idToken({ localId: 'ghost', email: 'ghost@e2e.test', password: '', createdAt: Date.now() });
      await expect(getAuth(app).verifyIdToken(forged)).rejects.toThrow();
    } finally {
      await deleteApp(app);
    }
  });
});
