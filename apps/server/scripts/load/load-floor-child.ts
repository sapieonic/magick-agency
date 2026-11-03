/**
 * A shard of the load harness's agent floor (`cluster-media-load.ts`), in its own process:
 * joins its agents through real station sockets (`media=alaw8`, `client=web|mobile` per
 * agent), makes them available, pings like the console or the app, talks at 50 frames a
 * second, and counts the frames it hears (and, on a mobile station, the server's probe pings).
 * IPC: `{ join: { tenantId, accountId, campaignId, userIds, clients } }` in, `{ joined }` out;
 * `{ stats }` on request; `{ stop }`.
 */
import { initDbPool } from '@magick-agency/db';
import { ClusterFloor, type FloorClient } from '../../test/helpers/cluster-floor.js';

async function main(): Promise<void> {
  initDbPool({ url: process.env['DATABASE_URL']!, poolMin: 0, poolMax: 4 });
  const floor = new ClusterFloor(process.env['LOAD_ORIGIN']!);
  process.on('message', (m: {
    join?: { tenantId: string; accountId: string; campaignId: string; userIds: string[]; clients: FloorClient[] };
    stats?: boolean;
    stop?: boolean;
  }) => {
    if (m.join) {
      const j = m.join;
      void (async () => {
        for (const [i, agentUserId] of j.userIds.entries()) {
          await floor.join({ tenantId: j.tenantId, accountId: j.accountId, campaignId: j.campaignId, agentUserId, client: j.clients[i] ?? 'web' });
        }
        floor.startPings();
        floor.startTalking();
        process.send!({ joined: floor.agents.length });
      })().catch((err) => { console.error(err); process.exit(1); });
    }
    if (m.stats) {
      const sum = (client: FloorClient, f: (a: (typeof floor.agents)[number]) => number) =>
        floor.agents.filter((a) => a.client === client).reduce((n, a) => n + f(a), 0);
      process.send!({ stats: {
        heard: floor.agents.reduce((n, a) => n + a.heard, 0),
        heardWeb: sum('web', (a) => a.heard),
        heardMobile: sum('mobile', (a) => a.heard),
        probePings: sum('mobile', (a) => a.probePings),
        mobileAgents: floor.agents.filter((a) => a.client === 'mobile').length,
        closed: floor.agents.filter((a) => a.closedWith !== null).length,
      } });
    }
    if (m.stop) void floor.close().finally(() => process.exit(0));
  });
  process.send!({ up: true });
}

void main();
