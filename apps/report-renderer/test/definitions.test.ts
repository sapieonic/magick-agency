/**
 * The definition keys: the fixtures carry the server's definitions (`datasets/definitions.ts`),
 * and the renderer's {@link DEFINITION_KEYS} must list exactly those keys, so a workbook lookup
 * typed against the list reads a key a real dataset carries.
 */
import { describe, expect, it } from 'vitest';
import { DEFINITION_KEYS, SUPERVISOR_ONLY_AGENT_KEYS } from '../src/definitions';
import { accountFixture } from './fixtures/account';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';

const keys = (d: { definitions: Array<{ key: string }> }) => d.definitions.map((x) => x.key);

describe('definition keys', () => {
  it('the agent review: every key for a supervisor, all but the comparison and analysis for the agent', () => {
    expect(keys(agentFixture().dataset)).toEqual([...DEFINITION_KEYS.agent]);
    const supervisorOnly: readonly string[] = SUPERVISOR_ONLY_AGENT_KEYS;
    expect(keys(agentFixture({ audience: 'self' }).dataset)).toEqual(DEFINITION_KEYS.agent.filter((k) => !supervisorOnly.includes(k)));
  });

  it('the campaign report', () => {
    expect(keys(campaignFixture().dataset)).toEqual([...DEFINITION_KEYS.campaign]);
  });

  it('the account report', () => {
    expect(keys(accountFixture().dataset)).toEqual([...DEFINITION_KEYS.account]);
  });
});
