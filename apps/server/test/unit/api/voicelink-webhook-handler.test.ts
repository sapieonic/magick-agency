import { describe, expect, it, vi } from 'vitest';
import { handleVoicelinkStatusWebhook } from '../../../src/api/routes/webhooks.routes.js';

/*
 * The status webhook as a function of plain data (docs/scaling.md §3.2), so the process
 * that owns a call can run it for a post that arrived elsewhere. Its answers are the
 * route's: 403 on a refused token without touching the bridge, 200 otherwise, and an
 * informational event (`call.initiated`) reaches no handler.
 */
function bridge(tokenOk: boolean) {
  return {
    verifyWsToken: vi.fn().mockResolvedValue(tokenOk),
    handleVoicelinkStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleVoicelinkStatusWebhook', () => {
  it('refuses a bad token 403 and hands nothing to the bridge', async () => {
    const b = bridge(false);
    const answer = await handleVoicelinkStatusWebhook(b as never, 'call-1', 'nope', { event: 'call.answered' });
    expect(answer).toEqual({ statusCode: 403, body: { status: false } });
    expect(b.verifyWsToken).toHaveBeenCalledWith('call-1', 'nope', 'webhook');
    expect(b.handleVoicelinkStatus).not.toHaveBeenCalled();
  });

  it('passes a lifecycle event to the bridge and answers 200', async () => {
    const b = bridge(true);
    const answer = await handleVoicelinkStatusWebhook(b as never, 'call-1', 'tok', { event: 'call.answered', call_id: 'vl-1' });
    expect(answer).toEqual({ statusCode: 200, body: { status: true } });
    expect(b.handleVoicelinkStatus).toHaveBeenCalledWith('call-1', expect.objectContaining({ eventType: expect.any(String) }));
  });

  it('answers 200 for an informational event without calling the bridge', async () => {
    const b = bridge(true);
    const answer = await handleVoicelinkStatusWebhook(b as never, 'call-1', 'tok', { event: 'call.initiated' });
    expect(answer).toEqual({ statusCode: 200, body: { status: true } });
    expect(b.handleVoicelinkStatus).not.toHaveBeenCalled();
  });
});
