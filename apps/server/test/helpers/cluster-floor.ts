import WebSocket from 'ws';
import Redis from 'ioredis';
import { config } from '../../src/config/index.js';
import { agencyAgentSessionRepository } from '../../src/db/repositories/agency.repository.js';
import { StationTokenStore } from '../../src/agency/station-token.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../src/agency/agent-state-machine.js';
import { TEST_REDIS_URL } from './test-redis.js';

/**
 * A floor of agents for a server running in another process tree (`cluster-server.ts`),
 * joined the way the full-stack suite joins them: the session row and the station token
 * written directly (the repository and Redis the server reads), then a REAL station
 * socket upgrade to the server's port (`media=alaw8`, the console's default), then the
 * agent made available. Each station counts the A-law frames it hears, can talk back at
 * 50 frames a second, and pings like the console so the silent-station sweep leaves it be.
 *
 * `client: 'mobile'` joins as the app does (`client=mobile`): the server then probes the
 * station with RFC 6455 pings every 3 s, which `ws` answers on its own, as the phone's
 * WebSocket stack does; they are counted in `probePings`. The app pings every 10 s.
 */
export type FloorClient = 'web' | 'mobile';

export interface FloorAgent {
  sessionId: string;
  client: FloorClient;
  /** The server's protocol pings this station received (a `mobile` station is probed). */
  probePings: number;
  /** Close code, if the server closed or dropped the station. */
  closedWith: number | null;
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  /** Binary A-law frames received (the customer's audio). */
  heard: number;
}

export class ClusterFloor {
  readonly agents: FloorAgent[] = [];
  private readonly redis: Redis;
  private readonly tokens: StationTokenStore;
  private readonly states: AgentStateMachine;
  private pinger: NodeJS.Timeout | null = null;
  private talker: NodeJS.Timeout[] = [];

  constructor(private readonly origin: string) {
    this.redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
    this.tokens = new StationTokenStore(this.redis, config.redis.keyPrefix);
    this.states = new AgentStateMachine(this.redis, config.redis.keyPrefix);
  }

  get redisClient(): Redis {
    return this.redis;
  }

  async join(input: { tenantId: string; accountId: string; campaignId: string; agentUserId: string; client?: FloorClient }): Promise<FloorAgent> {
    const { client = 'web', ...who } = input;
    const join = await agencyAgentSessionRepository.joinOrRehydrate({ ...who, replicaId: 'test-floor' });
    if (!join.ok) throw new Error('join refused');
    const sessionId = join.session.id;
    const { token } = await this.tokens.mint(sessionId);
    const url = `${this.origin.replace('http', 'ws')}/proxy/agency/station/${sessionId}?token=${token}&media=alaw8&client=${client}`;
    const agent: FloorAgent = { sessionId, client, probePings: 0, closedWith: null, ws: new WebSocket(url), frames: [], heard: 0 };
    agent.ws.on('ping', () => { agent.probePings++; });
    agent.ws.on('close', (code) => { agent.closedWith = code; });
    agent.ws.on('message', (raw, isBinary) => {
      if (isBinary) { agent.heard++; return; }
      agent.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`station ${sessionId} not ready`)), 20_000);
      agent.ws.once('error', reject);
      const check = (): void => {
        if (agent.frames.some((f) => f['event'] === 'ready')) { clearTimeout(t); resolve(); return; }
        setTimeout(check, 20);
      };
      check();
    });
    await this.states.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agencyAgentSessionRepository.setState(sessionId, 'available');
    this.agents.push(agent);
    return agent;
  }

  /** Ping every 5 s, as the console does; a mobile station every 10 s, as the app does. */
  startPings(): void {
    let tick = 0;
    this.pinger = setInterval(() => {
      tick++;
      for (const a of this.agents) {
        if (a.client === 'mobile' && tick % 2 === 1) continue;
        if (a.ws.readyState === WebSocket.OPEN) a.ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
      }
    }, 5_000);
    this.pinger.unref();
  }

  /** Every agent sends one 160-byte A-law frame every 20 ms (spread over 10 groups). */
  startTalking(): void {
    const frame = Buffer.alloc(160, 0x55);
    const groups = 10;
    for (let g = 0; g < groups; g++) {
      const t = setTimeout(() => {
        const iv = setInterval(() => {
          for (let i = g; i < this.agents.length; i += groups) {
            const ws = this.agents[i]!.ws;
            if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
          }
        }, 20);
        this.talker.push(iv);
      }, g * 2);
      this.talker.push(t);
    }
  }

  stopTalking(): void {
    for (const t of this.talker.splice(0)) clearInterval(t);
  }

  async close(): Promise<void> {
    this.stopTalking();
    if (this.pinger) clearInterval(this.pinger);
    await Promise.all(this.agents.map((a) => new Promise<void>((resolve) => {
      if (a.ws.readyState === WebSocket.CLOSED) return resolve();
      a.ws.once('close', () => resolve());
      a.ws.close();
      setTimeout(resolve, 2_000).unref();
    })));
    await this.redis.quit().catch(() => {});
  }
}
