import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { accountOrRefuse } from '../../../../../src/api/routes/helpers/account-scope.js';

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('accountOrRefuse', () => {
  it('answers the account and sends nothing when there is one', () => {
    const reply = fakeReply();
    expect(accountOrRefuse('a-1', reply as unknown as FastifyReply)).toBe('a-1');
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('refuses %o: 400 account_scope_required, the body byte for byte', (accountId) => {
    const reply = fakeReply();
    expect(accountOrRefuse(accountId, reply as unknown as FastifyReply)).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(JSON.stringify(reply.send.mock.calls[0]![0])).toBe(
      '{"error":"Bad Request","code":"account_scope_required","message":"This read is scoped to one account. Send X-Account-Id."}',
    );
  });

  it('sends the caller’s message when given one', () => {
    const reply = fakeReply();
    accountOrRefuse(null, reply as unknown as FastifyReply, 'Scoped. Send X-Account-Id.');
    expect(reply.send.mock.calls[0]![0]).toEqual({
      error: 'Bad Request', code: 'account_scope_required', message: 'Scoped. Send X-Account-Id.',
    });
  });
});
