import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { sendRefusal, VALIDATION_FAILED_TITLE } from '../../../../../src/api/routes/helpers/refusal.js';

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

function sent(status: number, opts?: Parameters<typeof sendRefusal>[4]) {
  const reply = fakeReply();
  sendRefusal(reply as unknown as FastifyReply, status, 'some_code', 'Some message.', opts);
  expect(reply.code).toHaveBeenCalledWith(status);
  return reply.send.mock.calls[0]![0];
}

describe('sendRefusal', () => {
  it('titles each refusal status', () => {
    expect(sent(400).error).toBe('Bad Request');
    expect(sent(403).error).toBe('Forbidden');
    expect(sent(404).error).toBe('Not Found');
    expect(sent(409).error).toBe('Conflict');
    expect(sent(502).error).toBe('Bad Gateway');
    expect(sent(503).error).toBe('Service Unavailable');
    expect(sent(418).error).toBe('Error');
  });

  it('the agent-retry vocabulary titles its 400 `Validation failed`, and only its 400', () => {
    expect(sent(400, { badRequestTitle: VALIDATION_FAILED_TITLE }).error).toBe('Validation failed');
    expect(sent(409, { badRequestTitle: VALIDATION_FAILED_TITLE }).error).toBe('Conflict');
  });

  it('sends `{ error, code, message }`, with `details` only when given', () => {
    expect(sent(409)).toEqual({ error: 'Conflict', code: 'some_code', message: 'Some message.' });
    expect(sent(400, { details: { min: 1 } })).toEqual({
      error: 'Bad Request', code: 'some_code', message: 'Some message.', details: { min: 1 },
    });
  });
});
