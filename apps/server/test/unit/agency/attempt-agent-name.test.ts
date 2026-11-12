import { describe, expect, it, vi } from 'vitest';
import { enrichAttemptAgentName } from '../../../src/agency/agency-spine.js';

/** `enrichAttemptAgentName` (`agency-spine.ts`): one attempt's `agent_name`, the call detail's. */
describe('enrichAttemptAgentName', () => {
  it('puts the name beside the id, the rest of the attempt spread through', async () => {
    const resolve = vi.fn(async () => new Map([['u-1', 'Ravi Menon']]));
    const out = await enrichAttemptAgentName({ id: 'a-1', agent_user_id: 'u-1', state: 'completed' }, 't-1', resolve);
    expect(out).toEqual({ id: 'a-1', agent_user_id: 'u-1', state: 'completed', agent_name: 'Ravi Menon' });
    expect(resolve).toHaveBeenCalledWith(['u-1'], 't-1');
  });

  it.each([null, undefined, '', 42])('an attempt with agent_user_id %o: agent_name null, no lookup', async (id) => {
    const resolve = vi.fn();
    const out = await enrichAttemptAgentName({ id: 'a-1', agent_user_id: id }, 't-1', resolve);
    expect(out.agent_name).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a lookup that finds no name, or throws, is agent_name null (the throw handed to onError)', async () => {
    expect((await enrichAttemptAgentName({ agent_user_id: 'u-1' }, 't-1', async () => new Map())).agent_name).toBeNull();
    const onError = vi.fn();
    const err = new Error('down');
    const out = await enrichAttemptAgentName({ agent_user_id: 'u-1' }, 't-1', async () => { throw err; }, onError);
    expect(out).toEqual({ agent_user_id: 'u-1', agent_name: null });
    expect(onError).toHaveBeenCalledWith(err);
  });
});
