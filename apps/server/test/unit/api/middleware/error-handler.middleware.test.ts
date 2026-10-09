import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.logger }));

import { errorHandler } from '../../../../src/api/middleware/error-handler.middleware.js';

function makeReply(): any {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply); // enable chaining
  return reply;
}

function makeRequest(overrides: Record<string, unknown> = {}): any {
  return { id: 'req-1', method: 'GET', url: '/test', ...overrides };
}

describe('errorHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('status code selection', () => {
    it('should use error.statusCode when present', () => {
      const reply = makeReply();
      errorHandler({ statusCode: 404, message: 'Not Found', name: 'NotFoundError' } as any, makeRequest(), reply);
      expect(reply.code).toHaveBeenCalledWith(404);
    });

    it('should default to 500 when statusCode is absent', () => {
      const reply = makeReply();
      errorHandler({ message: 'oops', name: 'Error' } as any, makeRequest(), reply);
      expect(reply.code).toHaveBeenCalledWith(500);
    });
  });

  describe('logging', () => {
    it('should log.error for 5xx errors', () => {
      errorHandler({ statusCode: 500, message: 'Server Error', name: 'Error' } as any, makeRequest(), makeReply());
      expect(mocks.logger.error).toHaveBeenCalled();
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it('should log.error for 503', () => {
      errorHandler({ statusCode: 503, message: 'Unavailable', name: 'Error' } as any, makeRequest(), makeReply());
      expect(mocks.logger.error).toHaveBeenCalled();
    });

    it('should log.warn for 4xx errors', () => {
      errorHandler({ statusCode: 400, message: 'Bad Request', name: 'Error' } as any, makeRequest(), makeReply());
      expect(mocks.logger.warn).toHaveBeenCalled();
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('should log.warn for 404', () => {
      errorHandler({ statusCode: 404, message: 'Not Found', name: 'Error' } as any, makeRequest(), makeReply());
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    it('should include requestId, method, and url in log context', () => {
      const req = makeRequest({ requestId: 'custom-id', method: 'POST', url: '/accounts' });
      errorHandler({ statusCode: 500, message: 'err', name: 'Error' } as any, req, makeReply());
      const [ctx] = mocks.logger.error.mock.calls[0]!;
      expect(ctx).toMatchObject({ requestId: 'custom-id', method: 'POST', url: '/accounts' });
    });
  });

  describe('requestId resolution', () => {
    it('should prefer request.requestId over request.id', () => {
      const req = makeRequest({ id: 'fallback-id', requestId: 'preferred-id' });
      const reply = makeReply();
      errorHandler({ statusCode: 500, message: 'err', name: 'Error' } as any, req, reply);
      const sent = reply.send.mock.calls[0]![0];
      expect(sent.requestId).toBe('preferred-id');
    });

    it('should fall back to request.id when requestId is absent', () => {
      const req = makeRequest({ id: 'fallback-id' });
      const reply = makeReply();
      errorHandler({ statusCode: 500, message: 'err', name: 'Error' } as any, req, reply);
      const sent = reply.send.mock.calls[0]![0];
      expect(sent.requestId).toBe('fallback-id');
    });
  });

  describe('response body', () => {
    it('should send error name, message, statusCode, and requestId', () => {
      const reply = makeReply();
      errorHandler(
        { statusCode: 422, message: 'Validation failed', name: 'ValidationError' } as any,
        makeRequest({ requestId: 'req-99' }),
        reply,
      );
      expect(reply.send).toHaveBeenCalledWith({
        error: 'ValidationError',
        message: 'Validation failed',
        statusCode: 422,
        requestId: 'req-99',
      });
    });

    it('should fall back to "Error" as error name when name is missing', () => {
      const reply = makeReply();
      errorHandler({ statusCode: 500, message: 'oops' } as any, makeRequest(), reply);
      const sent = reply.send.mock.calls[0]![0];
      expect(sent.error).toBe('Error');
    });
  });
});
