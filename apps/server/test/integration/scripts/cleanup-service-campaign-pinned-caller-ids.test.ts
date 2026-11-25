import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, truncateAll } from '../setup/test-utils.js';
import {
  CR9_CLEANUP_ACTOR,
  cleanupServiceCampaignPinnedCallerIds,
  parseArgs,
} from '../../../scripts/cleanup-service-campaign-pinned-caller-ids.js';
import {
  ACCOUNT, OTHER_TENANT, PIN_OTHER, PIN_OWN, SVC1, SVC2, TENANT, callerIdsById, configChangedRows, seedPinnedWorld,
  type PinnedWorld,
} from '../agency/pinned-caller-id-world.js';

/**
 * The one-off CR9 clean-up script's main function, on real Postgres: a dry run changes nothing;
 * `--apply` removes only the pinned caller IDs, only from unfinished service-account campaigns,
 * with the IN8 `agency_campaign.config_changed` row for each; a campaign it would leave empty is
 * skipped (emptied with `--allow-empty`, never when running); a second apply changes nothing.
 */

let world: PinnedWorld;
let lines: string[];
const out = (line: string) => { lines.push(line); };
const run = (apply: boolean, allowEmpty = false) => cleanupServiceCampaignPinnedCallerIds({ apply, allowEmpty, out });

beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 }); });
beforeEach(async () => {
  await truncateAll();
  world = await seedPinnedWorld();
  lines = [];
});
afterAll(async () => {
  await closePool();
  await closeTestPool();
});

describe('scripts/cleanup-service-campaign-pinned-caller-ids (integration)', () => {
  it('a dry run lists each campaign with its pinned caller IDs and credentials, and writes nothing', async () => {
    const before = await callerIdsById();
    const summary = await run(false);
    expect(await callerIdsById()).toEqual(before);
    expect(await configChangedRows()).toEqual([]);

    const c = world.campaigns;
    expect(summary).toMatchObject({ apply: false, found: 5 });
    expect(summary.counts).toEqual({ would_remove: 3, removed: 0, skipped_empty: 1, skipped_running_empty: 1, unchanged: 0, failed: 0 });
    expect(summary.results.map((r) => [r.campaign_id, r.result])).toEqual([
      [c.draftMixed, 'would_remove'], [c.runningMixed, 'would_remove'], [c.stoppingMixed, 'would_remove'],
      [c.pausedAllPinned, 'skipped_empty'], [c.runningAllPinned, 'skipped_running_empty'],
    ]);
    const text = lines.join('\n');
    expect(text).toContain('Dry run: nothing is written');
    expect(text).toContain(`Acme Collections (${TENANT}) / Mumbai (${ACCOUNT})`);
    expect(text).toContain(`campaign ${c.draftMixed} "A draft mixed", draft`);
    expect(text).toContain(`${PIN_OWN} pinned to credential ${world.ownCredential} "Own VoiceLink"`);
    expect(text).toContain(`${PIN_OTHER} pinned to credential ${world.otherCredential} "Their VoiceLink", another tenant's (${OTHER_TENANT})`);
    expect(text).toContain('2 of 3 caller IDs would remain');
    expect(text).toContain('SKIPPED: running, and it would be left with no caller ID');
    for (const finished of [c.completed, c.stopped, c.clean, c.onCredential]) expect(text).not.toContain(finished);
    expect(lines.at(-1)).toBe('Summary (dry run): 5 found; 3 would be cleaned, 2 would be skipped (left empty: 1 running).');
  });

  it('--apply removes only pinned IDs from unfinished service campaigns, audits each like a supervisor`s edit, and is idempotent', async () => {
    const c = world.campaigns;
    const before = await callerIdsById();
    const summary = await run(true);
    expect(summary.counts).toEqual({ would_remove: 0, removed: 3, skipped_empty: 1, skipped_running_empty: 1, unchanged: 0, failed: 0 });

    const after = await callerIdsById();
    expect(after.get(c.draftMixed)).toEqual([SVC1, SVC2]);
    expect(after.get(c.runningMixed)).toEqual([SVC1]);
    expect(after.get(c.stoppingMixed)).toEqual([SVC2]);
    // Skipped (would be empty), finished, on a credential or clean: untouched.
    for (const id of [c.pausedAllPinned, c.runningAllPinned, c.completed, c.stopped, c.onCredential, c.clean]) {
      expect(after.get(id)).toEqual(before.get(id));
    }

    const audit = await configChangedRows();
    expect(audit.map((r) => r.campaign_id)).toEqual([c.draftMixed, c.runningMixed, c.stoppingMixed]);
    expect(audit[0]).toEqual({
      tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'system', user_id: null,
      resource_id: c.draftMixed, campaign_id: c.draftMixed,
      details: {
        campaign_id: c.draftMixed,
        fields: ['caller_ids'],
        changes: { caller_ids: { from: [SVC1, PIN_OWN, SVC2], to: [SVC1, SVC2] } },
        actor: CR9_CLEANUP_ACTOR, via: 'cli', ruling: 'CR9',
        removed: [{ phone_number: PIN_OWN, telephony_credential_id: world.ownCredential }],
      },
    });
    expect(lines.join('\n')).toContain(`REMOVED ${PIN_OTHER}; 1 caller IDs remain`);
    expect(lines.at(-1)).toBe('Summary: 5 found; 3 cleaned, 0 unchanged, 2 skipped (would be left empty: 1 running), 0 failed.');

    // Again: the skipped two are still listed and skipped; nothing else is written.
    lines = [];
    const again = await run(true);
    expect(again).toMatchObject({ found: 2 });
    expect(again.counts).toMatchObject({ removed: 0, skipped_empty: 1, skipped_running_empty: 1, failed: 0 });
    expect(await callerIdsById()).toEqual(after);
    expect(await configChangedRows()).toHaveLength(3);
  });

  it('--allow-empty empties a campaign that is not running, never a running one; a further apply finds only the running one', async () => {
    const c = world.campaigns;
    const summary = await run(true, true);
    expect(summary.counts).toMatchObject({ removed: 4, skipped_empty: 0, skipped_running_empty: 1, failed: 0 });
    const after = await callerIdsById();
    expect(after.get(c.pausedAllPinned)).toEqual([]);
    expect(after.get(c.runningAllPinned)).toEqual([PIN_OWN, PIN_OTHER]);
    expect((await configChangedRows()).map((r) => r.campaign_id)).toContain(c.pausedAllPinned);

    lines = [];
    const again = await run(true, true);
    expect(again.found).toBe(1);
    expect(again.results).toEqual([{ campaign_id: c.runningAllPinned, result: 'skipped_running_empty', removed: [] }]);
    expect(await configChangedRows()).toHaveLength(4);
  });

  it('with nothing to clean, says so and writes nothing', async () => {
    await truncateAll();
    const summary = await run(true);
    expect(summary).toMatchObject({ found: 0, results: [] });
    expect(lines).toContain('No unfinished service-account campaign holds a pinned caller ID.');
  });

  it('takes only --apply, --allow-empty and --help; anything else is reported', () => {
    expect(parseArgs([])).toEqual({ apply: false, allowEmpty: false, help: false, unknown: [] });
    expect(parseArgs(['--apply', '--allow-empty'])).toEqual({ apply: true, allowEmpty: true, help: false, unknown: [] });
    expect(parseArgs(['--aply'])).toEqual({ apply: false, allowEmpty: false, help: false, unknown: ['--aply'] });
  });
});
