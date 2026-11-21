import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { sendRefusal, VALIDATION_FAILED_TITLE } from '../../../../../src/api/routes/helpers/refusal.js';

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn(), header: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  return reply;
}

let lastReply: ReturnType<typeof fakeReply>;
function sent(status: number, opts?: Parameters<typeof sendRefusal>[4]) {
  const reply = fakeReply();
  lastReply = reply;
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
    expect(sent(429).error).toBe('Too Many Requests');
    expect(sent(502).error).toBe('Bad Gateway');
    expect(sent(503).error).toBe('Service Unavailable');
    expect(sent(418).error).toBe('Error');
  });

  it('the agent-retry vocabulary titles its 400 `Validation failed`, and only its 400', () => {
    expect(sent(400, { badRequestTitle: VALIDATION_FAILED_TITLE }).error).toBe('Validation failed');
    expect(sent(409, { badRequestTitle: VALIDATION_FAILED_TITLE }).error).toBe('Conflict');
  });

  it('with retryAfterSeconds, sets Retry-After and retry_after_seconds after the message; without, neither', () => {
    expect(JSON.stringify(sent(429, { retryAfterSeconds: 5 }))).toBe(JSON.stringify({
      error: 'Too Many Requests', code: 'some_code', message: 'Some message.', retry_after_seconds: 5,
    }));
    expect(lastReply.header).toHaveBeenCalledWith('Retry-After', '5');
    expect(sent(429)).not.toHaveProperty('retry_after_seconds');
    expect(lastReply.header).not.toHaveBeenCalled();
  });

  it('sends `{ error, code, message }`, with `details` only when given', () => {
    expect(sent(409)).toEqual({ error: 'Conflict', code: 'some_code', message: 'Some message.' });
    expect(sent(400, { details: { min: 1 } })).toEqual({
      error: 'Bad Request', code: 'some_code', message: 'Some message.', details: { min: 1 },
    });
  });
});
