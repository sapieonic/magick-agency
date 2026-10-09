import { describe, it, expect, vi } from 'vitest';

/**
 * Importing AuthContext must NOT initialize Firebase.
 *
 * `getAuth()` throws `auth/invalid-api-key` when the VITE_FIREBASE_* vars are
 * absent, which is exactly the case in CI (no `.env` is committed). While this
 * module initialized Firebase as an import side effect, ANY test that
 * transitively reached AuthContext — often via a page → context → context chain
 * it never referenced directly — died at import time, before a single assertion
 * ran.
 *
 * That made the failure look like it belonged to whichever unrelated file
 * happened to add the import: three MessagesPage test files broke when a media
 * component started importing MetadataContext, which imports AuthContext. Each
 * had "protected" itself only by coincidentally mocking a different context on
 * the old path.
 *
 * This pins the contract: import is inert, and the throw (when it must happen)
 * lands on the component that actually uses auth.
 */

const state = vi.hoisted(() => ({ getAuthCalls: 0, initCalls: 0 }));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => {
    state.initCalls += 1;
    return {};
  }),
}));

vi.mock('firebase/auth', () => ({
  // Mirrors the real SDK's behaviour with a missing/invalid API key.
  getAuth: vi.fn(() => {
    state.getAuthCalls += 1;
    throw Object.assign(new Error('Firebase: Error (auth/invalid-api-key).'), {
      code: 'auth/invalid-api-key',
    });
  }),
  onAuthStateChanged: vi.fn(() => vi.fn()),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

describe('AuthContext — Firebase initialization is lazy', () => {
  it('does not touch Firebase merely because the module was imported', async () => {
    // A bare import is what a transitive page→context chain performs. If this
    // module initialized eagerly, the import itself would reject here.
    await expect(import('../../contexts/AuthContext')).resolves.toBeDefined();

    expect(state.getAuthCalls).toBe(0);
    expect(state.initCalls).toBe(0);
  });

  it('still exports the provider and hook for real consumers', async () => {
    const mod = await import('../../contexts/AuthContext');
    expect(typeof mod.AuthProvider).toBe('function');
    expect(typeof mod.useAuth).toBe('function');
    // Importing them is still inert — nothing has needed auth yet.
    expect(state.getAuthCalls).toBe(0);
  });
});
