/**
 * Whether a frame of call audio carries sound, judged the same way on both sides of a call: the
 * simulated carrier (what the agent's browser sent) and the station page (what the customer
 * sent the browser). Both are A-law 8 kHz on the wire.
 */
import { decodeAlaw } from '../../../server/src/utils/audio.js';

/**
 * RMS above a low floor: the fake microphone and the simulated customer both send a tone, while
 * silence and comfort noise decode to near 0.
 */
export function hasSound(alaw: Buffer): boolean {
  const pcm = decodeAlaw(alaw);
  if (pcm.length === 0) return false;
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return Math.sqrt(sum / pcm.length) > 200;
}
