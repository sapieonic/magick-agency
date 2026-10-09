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
 * PORT NOTE (magick-agency): `config.firebase` is optional in agency's platform
 * block (see `config/blocks/platform.ts`), so a missing block leaves Firebase
 * uninitialised and every `verifyIdToken` throws — the session middleware maps
 * that to 401, i.e. fail closed. `startPlatform` refuses to boot in production
 * without the block. `serviceAccountPath` (FIREBASE_SERVICE_ACCOUNT_PATH) is NEW:
 * the same JSON, read from a file (agency has its own service account in the
 * shared project, plan §3.1). Everything else is master's.
 */
export async function initFirebase(config: AppConfig): Promise<void> {
  const firebase = config.firebase;
  if (!firebase) {
    log.warn('Firebase not configured (FIREBASE_PROJECT_ID unset): every ID-token verification will fail closed');
    return;
  }
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');

  if (getApps().length > 0) {
    firebaseApp = getApps()[0];
    firebaseAuth = getAuth(firebaseApp);
    return;
  }

  const appOptions: any = { projectId: firebase.projectId };

  let serviceAccountJson = firebase.serviceAccountKey;
  if (!serviceAccountJson && firebase.serviceAccountPath) {
    const { readFileSync } = await import('node:fs');
    serviceAccountJson = readFileSync(firebase.serviceAccountPath, 'utf8');
  }
  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      appOptions.credential = cert(serviceAccount);
    } catch (err) {
      log.error({ err }, 'Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON');
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_KEY');
    }
  }

  firebaseApp = initializeApp(appOptions);
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
