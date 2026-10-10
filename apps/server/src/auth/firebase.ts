import type { AppConfig } from '../config/schema.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'firebase' });

// firebase-admin types
let firebaseApp: any = null;
let firebaseAuth: any = null;

export interface DecodedFirebaseToken {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

/*
 * `config.firebase` is optional in the platform config block (see
 * `config/blocks/platform.ts`), so a missing block leaves Firebase uninitialised
 * and every `verifyIdToken` throws — the session middleware maps that to 401,
 * i.e. fail closed. `startPlatform` refuses to boot in production without the
 * block.
 *
 * No service account: the only Admin call is `verifyIdToken` without the
 * revocation check, which verifies the signature against Google's public keys
 * (fetched unauthenticated) and the audience against the project id. A future
 * call that needs Google API access (user lookup, revocation) needs a
 * credential added back here.
 */
export async function initFirebase(config: AppConfig): Promise<void> {
  const firebase = config.firebase;
  if (!firebase) {
    log.warn('Firebase not configured (FIREBASE_PROJECT_ID unset): every ID-token verification will fail closed');
    return;
  }
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');

  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    firebaseAuth = getAuth(firebaseApp);
    return;
  }

  firebaseApp = initializeApp({ projectId: firebase.projectId });
  firebaseAuth = getAuth(firebaseApp);
  log.info({ projectId: firebase.projectId }, 'Firebase Admin initialized');
}

export async function verifyIdToken(idToken: string): Promise<DecodedFirebaseToken> {
  if (!firebaseAuth) throw new Error('Firebase not initialized. Call initFirebase first.');

  const decoded = await firebaseAuth.verifyIdToken(idToken);
  return {
    uid: decoded.uid,
    email: decoded.email,
    name: decoded.name,
    picture: decoded.picture,
    email_verified: decoded.email_verified,
  };
}
