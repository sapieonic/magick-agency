import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgencyMyDay } from '@magick-agency/contracts/api/agency/my-day';

/**
 * The contract's agent read samples (`packages/contracts/fixtures/agent/reads.json`), read from
 * disk so the console's station tests run against the same my-day answers as the server and the
 * agent app.
 */

const FIXTURES = resolve(__dirname, '../../../../../packages/contracts/fixtures/agent');

export interface AgentReadsFixture {
  /** A strict campaign with a target, promises and three call-laters (one overdue). */
  my_day: AgencyMyDay;
  /** A pool campaign with no target, no promises and no call-laters. */
  my_day_pool_no_target: AgencyMyDay;
}

/** A fresh deep copy on every call, so a test that edits it cannot leak into the next. */
export function agentReadsFixture(): AgentReadsFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, 'reads.json'), 'utf-8')) as AgentReadsFixture;
}
