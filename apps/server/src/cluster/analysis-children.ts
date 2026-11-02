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

export function createAnalysisChildren(opts: AnalysisChildrenOptions): ChildSupervisor {
  const children: ChildSupervisor = new ChildSupervisor({
    role: 'analysis',
    count: opts.count,
    fork: opts.fork,
    onChannel: (slot, channel) => {
      channel.onEvent('analysis.rate_paused', (body) => {
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
