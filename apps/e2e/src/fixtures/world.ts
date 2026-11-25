/**
 * Seeding through the product's own APIs (never SQL, so the seed cannot drift from the schema).
 *
 * `seedWorld()` makes a fresh tenant per test over the super-admin REST API: an owner, a
 * supervisor (`account_admin`), two agents and two VoiceLink caller IDs assigned to it. Each
 * user is also registered with the fake Firebase, so their first console sign-in activates the
 * membership the super-admin created, exactly as a real first sign-in does.
 */
import { randomBytes } from 'node:crypto';
import { SUPER_ADMIN, urls } from '../env.js';
import { sim } from './sim-client.js';

export interface WorldUser {
  email: string;
  password: string;
  name: string;
  role: 'tenant_owner' | 'account_admin' | 'agent' | 'tenant_admin' | 'operator' | 'viewer';
}

export interface World {
  tenantId: string;
  tenantName: string;
  accountId: string;
  owner: WorldUser;
  supervisor: WorldUser;
  agents: [WorldUser, WorldUser];
  /** E.164 caller IDs assigned to the tenant (VoiceLink). */
  callerIds: string[];
  /** A short random tag unique to this world, for names and numbers. */
  tag: string;
}

/**
 * One super-admin token per worker: `/super-admin/login` allows 5 a minute per IP (fixed in the
 * route), and every request of the run comes from 127.0.0.1. The token lasts 4 hours.
 */
let cachedToken: string | null = null;

export class SuperAdminApi {
  private token: string | null = cachedToken;

  async login(email = SUPER_ADMIN.email, password = SUPER_ADMIN.password): Promise<void> {
    if (cachedToken && email === SUPER_ADMIN.email) {
      this.token = cachedToken;
      return;
    }
    const r = await fetch(`${urls.server}/super-admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`super-admin login -> ${r.status}: ${await r.text()}`);
    this.token = ((await r.json()) as { token: string }).token;
    if (email === SUPER_ADMIN.email) cachedToken = this.token;
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) await this.login();
    const r = await fetch(`${urls.server}/super-admin${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`super-admin ${method} ${path} -> ${r.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async providerId(name: 'voicelink' | 'plivo'): Promise<string> {
    const { providers } = await this.req<{ providers: Array<{ id: string; name: string }> }>('GET', '/telephony-providers');
    const p = providers.find((x) => x.name === name);
    if (!p) throw new Error(`no telephony provider ${name}`);
    return p.id;
  }
}

/** A strong password that contains nothing of the address (the console refuses ones that do). */
const password = () => `Zx-${randomBytes(6).toString('hex')}-Qv9`;

/** A unique Indian mobile number in E.164 (+91 9xxxxxxxxx). */
export function uniqueE164(): string {
  return `+919${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
}

export async function seedWorld(label = 'World'): Promise<World> {
  const api = new SuperAdminApi();
  await api.login();
  const tag = randomBytes(3).toString('hex');
  const mk = (who: string, role: WorldUser['role'], name: string): WorldUser => ({
    email: `${who}.${tag}@e2e.test`,
    password: password(),
    name,
    role,
  });
  const owner = mk('owner', 'tenant_owner', `Owner ${tag}`);
  const supervisor = mk('super', 'account_admin', `Supervisor ${tag}`);
  const agents: [WorldUser, WorldUser] = [mk('agent1', 'agent', `Asha ${tag}`), mk('agent2', 'agent', `Ravi ${tag}`)];

  const tenantName = `${label} ${tag}`;
  const { tenant } = await api.req<{ tenant: { id: string } }>('POST', '/tenants', {
    name: tenantName,
    owner_email: owner.email,
    owner_name: owner.name,
  });
  const { accounts } = await api.req<{ accounts: Array<{ id: string }> }>('GET', `/tenants/${tenant.id}/accounts`);
  const accountId = accounts[0]!.id;
  for (const u of [supervisor, ...agents]) {
    await api.req('POST', `/tenants/${tenant.id}/users`, { email: u.email, role: u.role, name: u.name, account_id: accountId });
  }
  for (const u of [owner, supervisor, ...agents]) await sim.registerUser(u.email, u.password, u.name);

  const providerId = await api.providerId('voicelink');
  const callerIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const phone = uniqueE164();
    const { phone_number } = await api.req<{ phone_number: { id: string } }>('POST', '/phone-numbers', {
      phone_number: phone,
      provider_id: providerId,
      label: `E2E caller ${i + 1}`,
      max_concurrent_calls: 10,
    });
    await api.req('POST', `/phone-numbers/${phone_number.id}/assign`, { tenant_id: tenant.id, is_default: i === 0 });
    callerIds.push(phone);
  }
  return { tenantId: tenant.id, tenantName, accountId, owner, supervisor, agents, callerIds, tag };
}
