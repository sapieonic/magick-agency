/**
 * The console's own API, called as a seeded user (a fake-Firebase ID token, the tenant and
 * account headers the console sends). Specs use it to set up what a spec is not about, the
 * same calls New campaign makes, so a call spec starts from a running campaign in seconds.
 */
import { urls } from '../env.js';
import { sim } from './sim-client.js';
import type { World, WorldUser } from './world.js';

export interface Contact {
  name: string;
  /** National number, 10 digits; its last two digits pick the simulator's persona. */
  phone: string;
  city?: string;
}

export interface CampaignOptions {
  name: string;
  contacts: Contact[];
  /** Agents staffed on it (default: both of the world's agents). */
  agents?: WorldUser[];
  wrapupSeconds?: number;
  /** Start it (default true). */
  start?: boolean;
  outcomes?: Array<Record<string, unknown>>;
}

export const DEFAULT_OUTCOMES = [
  { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ConsoleApi {
  private constructor(
    private readonly token: string,
    readonly userId: string,
    private readonly tenantId: string,
    private readonly accountId: string,
  ) {}

  /** Sign `user` in (the server's first-sign-in activation included) and return a client for them. */
  static async as(world: World, user: WorldUser): Promise<ConsoleApi> {
    const token = await sim.idToken(user.email, user.password);
    const r = await fetch(`${urls.server}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id_token: token }),
    });
    if (!r.ok) throw new Error(`session for ${user.email} -> ${r.status}: ${await r.text()}`);
    const { user: me } = (await r.json()) as { user: { id: string } };
    return new ConsoleApi(token, me.id, world.tenantId, world.accountId);
  }

  /** The HTTP status of a GET as this user, optionally scoped to another tenant and account. */
  async statusOf(path: string, scope?: { tenantId: string; accountId: string }): Promise<number> {
    const r = await fetch(`${urls.server}${path}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-tenant-id': scope?.tenantId ?? this.tenantId,
        'x-account-id': scope?.accountId ?? this.accountId,
      },
    });
    await r.body?.cancel();
    return r.status;
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isForm = body instanceof FormData;
    const r = await fetch(`${urls.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-tenant-id': this.tenantId,
        'x-account-id': this.accountId,
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Upload a roster, check it, and import it into `campaignId`, as New campaign's step 2 does. */
  async importContacts(campaignId: string, contacts: Contact[]): Promise<void> {
    const csv = ['name,phone,city', ...contacts.map((c) => `${c.name},${c.phone},${c.city ?? ''}`)].join('\n');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'roster.csv');
    const up = await this.req<{ s3_key: string; file_name: string }>('POST', '/proxy/agency/ingest/upload', form);
    const check = await this.req<{ job_id: string }>('POST', '/proxy/agency/ingest/jobs', {
      s3_key: up.s3_key, file_name: up.file_name, phone_column: 'phone', dry_run: true,
    });
    await this.waitJob(check.job_id);
    const imp = await this.req<{ job_id: string }>('POST', `/proxy/agency/ingest/jobs/${check.job_id}/import`, { campaign_id: campaignId });
    await this.waitJob(imp.job_id);
  }

  private async waitJob(jobId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = await this.req<{ status: string; error?: unknown }>('GET', `/proxy/agency/ingest/jobs/${jobId}`);
      if (job.status === 'completed') return;
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`ingest job ${jobId} ${job.status}: ${JSON.stringify(job)}`);
      if (Date.now() > deadline) throw new Error(`ingest job ${jobId} still ${job.status} after 60 s`);
      await sleep(300);
    }
  }

  /**
   * A campaign that dials all day, every day (so a run at any hour dials), with its contacts
   * imported and the agents staffed; started unless `start: false`.
   */
  async createCampaign(world: World, opts: CampaignOptions): Promise<{ id: string }> {
    const campaign = await this.req<{ id: string }>('POST', '/proxy/agency/campaigns', {
      name: opts.name,
      caller_ids: [world.callerIds[0]],
      telephony_provider: 'voicelink',
      telephony_credential_id: null,
      abandonment_ceiling_pct: 3,
      abandonment_grace_ms: 3000,
      template_id: null,
      disposition_catalog: opts.outcomes ?? DEFAULT_OUTCOMES,
      retry_policy: {},
      calling_window_start: '00:00',
      calling_window_end: '23:59',
      calling_days: [1, 2, 3, 4, 5, 6, 7],
      default_timezone: 'Asia/Kolkata',
      wrapup_seconds: opts.wrapupSeconds ?? 60,
      wrapup_auto_return: true,
      allow_wrapup_redial: false,
      inbound_sticky_enabled: true,
      outcome_dispositions: {},
      record_calls: false,
      analysis_profile_id: null,
      break_reasons: [],
      agent_script: {},
      phone_display: 'full',
      daily_target_calls: null,
    });
    await this.importContacts(campaign.id, opts.contacts);
    for (const agent of opts.agents ?? world.agents) {
      const a = await ConsoleApi.as(world, agent);
      await this.req('POST', `/proxy/agency/campaigns/${campaign.id}/agents`, { user_id: a.userId });
    }
    if (opts.start !== false) await this.req('POST', `/proxy/agency/campaigns/${campaign.id}/start`);
    return campaign;
  }
}

/**
 * A national mobile number unique to this run whose last two digits are `suffix` (the
 * simulator's persona: 01 answer, 02 busy, 03 no answer, 04 failed, 05 answer then hang up).
 */
export function phoneWithPersona(suffix: '01' | '02' | '03' | '04' | '05' | '06'): string {
  const middle = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
  return `9${middle}${suffix}`;
}
