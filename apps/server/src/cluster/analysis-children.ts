/**
 * The primary's analysis children (`ANALYSIS_WORKERS > 0`): a {@link ChildSupervisor} of
 * role `analysis` with the one piece of coordination they need, the vendor rate-limit
 * relay (D10). A child whose breaker opens announces `analysis.rate_paused`; the primary
 * sends it to every other child, which pauses its own claims until the same moment. Over
 * IPC through the primary, never Redis. Built here so `bootstrap/analysis.ts` and the
 * multi-process tests run the same wiring.
 */
import type { ChildProcess } from 'node:child_process';
import { createChildLogger } from '@magick-agency/observability';
import { ChildSupervisor } from './child-supervisor.js';

const log = createChildLogger({ component: 'analysis-children' });

export interface AnalysisChildrenOptions {
  count: number;
  fork: (slot: number) => ChildProcess;
  readyTimeoutMs?: number;
  restartBackoffMs?: readonly number[];
}

export function createAnalysisChildren(opts: AnalysisChildrenOptions, now: () => number = Date.now): ChildSupervisor {
  // The pause in force, if any. A child that is not ready when a pause is relayed (still
  // booting, or being restarted) would miss it and find the vendor's limit out for itself
  // with jobs of its own; it is told on `ready` instead.
  let current: { untilMs: number; consecutive: number } | null = null;
  const children: ChildSupervisor = new ChildSupervisor({
    role: 'analysis',
    count: opts.count,
    fork: opts.fork,
    onReady: (slot) => {
      if (!current || current.untilMs <= now()) return;
      children.channel(slot)?.emit('analysis.rate_paused', current);
      log.info({ slot, pausedForMs: current.untilMs - now() }, 'An analysis worker came up during a vendor rate-limit pause; pausing it too');
    },
    onChannel: (slot, channel) => {
      channel.onEvent('analysis.rate_paused', (body) => {
        if (!current || body.untilMs > current.untilMs) current = { untilMs: body.untilMs, consecutive: body.consecutive };
        const told = children.broadcast('analysis.rate_paused', body, slot);
        log.warn({ fromSlot: slot, told, pausedForMs: Math.max(0, body.untilMs - Date.now()), consecutive: body.consecutive },
          'An analysis worker was rate-limited by the AI vendor; pausing the other analysis workers');
      });
    },
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
    ...(opts.restartBackoffMs !== undefined ? { restartBackoffMs: opts.restartBackoffMs } : {}),
  });
  return children;
}
