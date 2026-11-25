/**
 * A fake Firebase Authentication REST service: just enough of `identitytoolkit.googleapis.com`
 * and `securetoken.googleapis.com` for the Firebase JS SDK's email/password flows in the console.
 *
 * The browser's requests to those hosts are routed here by Playwright (`fixtures/test.ts`);
 * nothing in the console changes. Tokens are unsigned (`alg: none`) JWTs with the claims of a
 * real ID token; the server accepts them because it runs with `FIREBASE_AUTH_EMULATOR_HOST`,
 * which puts firebase-admin's verifier in emulator mode: no signature check, and a revocation
 * lookup (`accounts:lookup` by `localId`) sent here, to the emulator host.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface FakeUser {
  localId: string;
  email: string;
  password: string;
  displayName?: string;
  createdAt: number;
}

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

export class FakeFirebaseAuth {
  private readonly byEmail = new Map<string, FakeUser>();
  private readonly refreshTokens = new Map<string, string>(); // token -> localId

  constructor(private readonly projectId: string) {}

  reset(): void {
    this.byEmail.clear();
    this.refreshTokens.clear();
  }

  /** A registered user by email (case-insensitive), or null. */
  userByEmail(email: string): FakeUser | null {
    return this.byEmail.get(email.trim().toLowerCase()) ?? null;
  }

  /** Register (or re-password) an account, as if the user had signed up. */
  upsertUser(email: string, password: string, displayName?: string): FakeUser {
    const key = email.trim().toLowerCase();
    const existing = this.byEmail.get(key);
    if (existing) {
      existing.password = password;
      if (displayName) existing.displayName = displayName;
      return existing;
    }
    const user: FakeUser = { localId: randomUUID().replace(/-/g, '').slice(0, 28), email: key, password, displayName, createdAt: Date.now() };
    this.byEmail.set(key, user);
    return user;
  }

  idToken(user: FakeUser): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `https://securetoken.google.com/${this.projectId}`,
      aud: this.projectId,
      auth_time: now,
      user_id: user.localId,
      sub: user.localId,
      iat: now,
      exp: now + 3600,
      email: user.email,
      email_verified: true,
      ...(user.displayName ? { name: user.displayName } : {}),
      firebase: { identities: { email: [user.email] }, sign_in_provider: 'password' },
    };
    return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
  }

  private session(user: FakeUser): Record<string, unknown> {
    const refreshToken = `rt_${randomUUID()}`;
    this.refreshTokens.set(refreshToken, user.localId);
    return {
      kind: 'identitytoolkit#VerifyPasswordResponse',
      localId: user.localId,
      email: user.email,
      displayName: user.displayName ?? '',
      idToken: this.idToken(user),
      registered: true,
      refreshToken,
      expiresIn: '3600',
    };
  }

  private userByToken(idToken: unknown): FakeUser | null {
    if (typeof idToken !== 'string') return null;
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
      return payload.email ? this.byEmail.get(payload.email) ?? null : null;
    } catch {
      return null;
    }
  }

  private userInfo(user: FakeUser): Record<string, unknown> {
    return {
      localId: user.localId,
      email: user.email,
      displayName: user.displayName,
      emailVerified: true,
      providerUserInfo: [{ providerId: 'password', email: user.email, federatedId: user.email, rawId: user.email, displayName: user.displayName }],
      passwordUpdatedAt: user.createdAt,
      validSince: String(Math.floor(user.createdAt / 1000)),
      lastLoginAt: String(Date.now()),
      createdAt: String(user.createdAt),
      lastRefreshAt: new Date().toISOString(),
    };
  }

  /**
   * Handle `/identitytoolkit.googleapis.com/...` and `/securetoken.googleapis.com/...`.
   * Returns false when the path is not ours.
   */
  handle(path: string, body: string, contentType: string, res: ServerResponse, req: IncomingMessage): boolean {
    const cors = {
      'access-control-allow-origin': String(req.headers.origin ?? '*'),
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(payload));
    };
    const fail = (message: string) => send(400, { error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } });
    const failed = (message: string): true => { fail(message); return true; };

    if (!path.startsWith('/identitytoolkit.googleapis.com/') && !path.startsWith('/securetoken.googleapis.com/')) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return true;
    }

    let json: Record<string, unknown> = {};
    if (contentType.includes('application/x-www-form-urlencoded')) {
      json = Object.fromEntries(new URLSearchParams(body));
    } else if (body) {
      try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* empty */ }
    }
    const op = path.split('/').pop() ?? '';

    if (path.startsWith('/securetoken.googleapis.com/')) {
      const localId = this.refreshTokens.get(String(json['refresh_token'] ?? ''));
      const user = localId ? [...this.byEmail.values()].find((u) => u.localId === localId) : undefined;
      if (!user) return failed('INVALID_REFRESH_TOKEN');
      const idToken = this.idToken(user);
      send(200, {
        access_token: idToken, expires_in: '3600', token_type: 'Bearer',
        refresh_token: json['refresh_token'], id_token: idToken, user_id: user.localId, project_id: this.projectId,
      });
      return true;
    }

    switch (op) {
      case 'accounts:signInWithPassword': {
        const user = this.byEmail.get(String(json['email'] ?? '').trim().toLowerCase());
        if (!user) return failed('EMAIL_NOT_FOUND');
        if (user.password !== json['password']) return failed('INVALID_PASSWORD');
        send(200, this.session(user));
        return true;
      }
      case 'accounts:signUp': {
        const email = String(json['email'] ?? '').trim().toLowerCase();
        if (!email) return failed('MISSING_EMAIL');
        if (this.byEmail.has(email)) return failed('EMAIL_EXISTS');
        const password = String(json['password'] ?? '');
        if (password.length < 6) return failed('WEAK_PASSWORD : Password should be at least 6 characters');
        const user = this.upsertUser(email, password, typeof json['displayName'] === 'string' ? json['displayName'] : undefined);
        send(200, { kind: 'identitytoolkit#SignupNewUserResponse', ...this.session(user) });
        return true;
      }
      case 'accounts:lookup': {
        // The browser SDK looks up by `idToken`; firebase-admin in emulator mode (the server's
        // revocation check on every verify) looks up by `localId`.
        if (Array.isArray(json['localId']) || Array.isArray(json['email'])) {
          const ids = new Set((json['localId'] as string[] | undefined) ?? []);
          const emails = new Set(((json['email'] as string[] | undefined) ?? []).map((e) => e.toLowerCase()));
          const users = [...this.byEmail.values()].filter((u) => ids.has(u.localId) || emails.has(u.email));
          send(200, { kind: 'identitytoolkit#GetAccountInfoResponse', ...(users.length ? { users: users.map((u) => this.userInfo(u)) } : {}) });
          return true;
        }
        const user = this.userByToken(json['idToken']);
        if (!user) return failed('INVALID_ID_TOKEN');
        send(200, { kind: 'identitytoolkit#GetAccountInfoResponse', users: [this.userInfo(user)] });
        return true;
      }
      case 'accounts:update': {
        const user = this.userByToken(json['idToken']);
        if (!user) return failed('INVALID_ID_TOKEN');
        if (typeof json['password'] === 'string') user.password = json['password'];
        if (typeof json['displayName'] === 'string') user.displayName = json['displayName'];
        send(200, { kind: 'identitytoolkit#SetAccountInfoResponse', ...this.userInfo(user), idToken: this.idToken(user), refreshToken: `rt_${randomUUID()}`, expiresIn: '3600' });
        return true;
      }
      case 'accounts:sendOobCode':
        send(200, { kind: 'identitytoolkit#GetOobConfirmationCodeResponse', email: json['email'] });
        return true;
      case 'accounts:createAuthUri':
        send(200, { kind: 'identitytoolkit#CreateAuthUriResponse', registered: this.byEmail.has(String(json['identifier'] ?? '').toLowerCase()), signinMethods: ['password'] });
        return true;
      case 'projects':
        send(200, { projectId: this.projectId, authorizedDomains: ['localhost', '127.0.0.1'] });
        return true;
      case 'recaptchaParams':
      case 'recaptchaConfig':
        send(200, { recaptchaEnforcementState: [] });
        return true;
      default:
        fail(`UNSUPPORTED_OPERATION ${op}`);
        return true;
    }
  }
}
