/**
 * The load harness's carrier (`cluster-media-load.ts`), in its own process so its
 * frames do not share a loop with the stations': the mock VoiceLink carrier, answering
 * every lead with one long call that streams loud A-law at 50 frames a second and counts
 * what the agent sends back. Talks to the harness over IPC: `{ baseUrl }` once started,
 * `{ origin }` in, `{ stats }` on request.
 */
import { MockVoicelinkCarrier, carrierScripts } from '../../test/mocks/voicelink/index.js';

const frames = Number(process.env['LOAD_CARRIER_FRAMES'] ?? 3_000);

async function main(): Promise<void> {
  let origin = '';
  const carrier = new MockVoicelinkCarrier({ targetOrigin: () => origin || null });
  const pattern = Array.from({ length: frames }, () => true);
  carrier.setScript(() => carrierScripts.answered({ pattern }).script);
  await carrier.start();
  process.on('message', (m: { origin?: string; stats?: boolean; stop?: boolean }) => {
    if (m.origin) origin = m.origin;
    if (m.stats) {
      let mediaIn = 0;
      for (const call of carrier.callOrder) mediaIn += call.mediaReceived.length;
      process.send!({ stats: { calls: carrier.callOrder.length, mediaIn } });
    }
    if (m.stop) void carrier.stop().finally(() => process.exit(0));
  });
  process.send!({ baseUrl: carrier.baseUrl, username: carrier.username, password: carrier.password });
}

void main();
