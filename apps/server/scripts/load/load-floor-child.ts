/**
 * A shard of the load harness's agent floor (`cluster-media-load.ts`), in its own process:
 * joins its agents through real station sockets (`media=alaw8`), makes them available,
 * pings like the console, talks at 50 frames a second, and counts the frames it hears.
 * IPC: `{ join: { tenantId, accountId, campaignId, userIds } }` in, `{ joined }` out;
 * `{ stats }` on request; `{ stop }`.
 */
import { initDbPool } from '@magick-agency/db';
import { ClusterFloor } from '../../test/helpers/cluster-floor.js';

async function main(): Promise<void> {
  initDbPool({ url: process.env['DATABASE_URL']!, poolMin: 0, poolMax: 4 });
  const floor = new ClusterFloor(process.env['LOAD_ORIGIN']!);
  process.on('message', (m: {
    join?: { tenantId: string; accountId: string; campaignId: string; userIds: string[] };
    stats?: boolean;
    stop?: boolean;
  }) => {
    if (m.join) {
      const j = m.join;
      void (async () => {
        for (const agentUserId of j.userIds) {
          await floor.join({ tenantId: j.tenantId, accountId: j.accountId, campaignId: j.campaignId, agentUserId });
        }
        floor.startPings();
        floor.startTalking();
        process.send!({ joined: floor.agents.length });
      })().catch((err) => { console.error(err); process.exit(1); });
    }
    if (m.stats) process.send!({ stats: { heard: floor.agents.reduce((n, a) => n + a.heard, 0) } });
    if (m.stop) void floor.close().finally(() => process.exit(0));
  });
  process.send!({ up: true });
}

void main();
