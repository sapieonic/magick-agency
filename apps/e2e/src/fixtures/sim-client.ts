/**
 * The specs' handle on the simulator's control API (`/_sim/*`): script the customer, read what
 * the vendors received.
 */
import { urls } from '../env.js';
import type { PersonaName, SimCall } from '../sim/voicelink.js';
import type { SentMail } from '../sim/vendors.js';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${urls.sim}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`sim ${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export const sim = {
  reset: () => call<{ ok: true }>('POST', '/_sim/reset'),
  /** Register a console sign-in (email + password) with the fake Firebase. */
  registerUser: (email: string, password: string, displayName?: string) =>
    call<{ localId: string }>('POST', '/_sim/firebase/users', { email, password, displayName }),
  /**
   * An ID token for `email`, for API calls made as that console user. Without `password` the
   * user must be registered already (their password is not touched).
   */
  idToken: async (email: string, password?: string) => {
    const { idToken, error } = await call<{ idToken?: string; error?: string }>('POST', '/_sim/firebase/token', { email, password });
    if (!idToken) throw new Error(`sim: no ID token for ${email}: ${error ?? 'unknown'}`);
    return idToken;
  },
  calls: async (number?: string) =>
    (await call<{ calls: SimCall[] }>('GET', `/_sim/calls${number ? `?number=${encodeURIComponent(number)}` : ''}`)).calls,
  /** The customer hangs up the live call to `number`. */
  hangup: async (number: string) => (await call<{ ok: boolean }>('POST', `/_sim/calls/${encodeURIComponent(number)}/hangup`)).ok,
  /** Every customer still on a call hangs up (the suite does this after each test). */
  hangupAll: async () => (await call<{ hungUp: number }>('POST', '/_sim/calls/hangup-all')).hungUp,
  setPersona: (number: string, persona: PersonaName, opts: { ringMs?: number; talkMs?: number } = {}) =>
    call<{ ok: true }>('POST', '/_sim/personas', { number, persona, ...opts }),
  clearPersonas: () => call<{ ok: true }>('DELETE', '/_sim/personas'),
  mail: async (to: string) => (await call<{ messages: SentMail[] }>('GET', `/_sim/mail?to=${encodeURIComponent(to)}`)).messages,
  s3Keys: async (bucket = 'e2e-bucket') => (await call<{ keys: string[] }>('GET', `/_sim/s3?bucket=${bucket}`)).keys,
  carrierRequests: async () =>
    (await call<{ requests: Array<{ route: string; status: number; body?: Record<string, string> }> }>('GET', '/_sim/carrier/requests')).requests,
};

/** The link in the newest mail to `to` that matches `pattern` (an invite's /join/<token>). */
export async function linkInMail(to: string, pattern = /https?:\/\/\S+\/join\/[\w-]+/): Promise<string | null> {
  const messages = await sim.mail(to);
  for (const m of [...messages].reverse()) {
    const hit = pattern.exec(m.text) ?? pattern.exec(m.html);
    if (hit) return hit[0];
  }
  return null;
}
