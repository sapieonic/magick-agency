import { describe, it, expect } from 'vitest';
import { formatValidationIssues, parseApiErrorBody } from '../src/apiErrorBody';
import { splitRequestId } from '../src/errors';

/**
 * The one reading of an error body both API clients share. The clients' own
 * suites (console `client.test.ts`, super-admin `saFetch.test.ts`) pin it
 * end to end; these pin the order and the edges directly.
 */

const headers = (id?: string) => new Headers(id ? { 'x-request-id': id } : {});

describe('parseApiErrorBody — message order', () => {
  it('reads `details` before Fastify’s generic message', () => {
    const r = parseApiErrorBody(400, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Bad Request',
      details: [{ path: ['to'], message: 'must be a valid E.164 number' }],
    });
    expect(r.message).toBe('to: must be a valid E.164 number');
  });

  it('reads `issues` before Fastify’s generic message', () => {
    const r = parseApiErrorBody(400, {
      error: 'Bad Request',
      message: 'Bad Request',
      issues: [{ path: ['actions', 0, 'channel'], message: 'Required' }],
    });
    expect(r.message).toBe('actions.0.channel: Required');
  });

  it('keeps a real `message` when the issue list says nothing readable', () => {
    const r = parseApiErrorBody(400, { message: 'Campaign is archived', issues: [{ code: 'custom' }] });
    expect(r.message).toBe('Campaign is archived');
  });

  it('decodes the Zod flatten shape', () => {
    const r = parseApiErrorBody(400, {
      error: 'Validation failed',
      details: { fieldErrors: { name: ['Required'], max: [] } },
    });
    expect(r.message).toBe('Validation failed: name: Required');
  });

  it('falls back to the `error` label, then to the given fallback', () => {
    expect(parseApiErrorBody(409, { error: 'Conflict' }).message).toBe('Conflict');
    expect(parseApiErrorBody(409, {}).message).toBe('API error 409');
    expect(parseApiErrorBody(401, {}, null, 'Login failed').message).toBe('Login failed');
  });

  it.each([['a string', 'oops'], ['null', null], ['a number', 7], ['an array', ['a', 'b']]])(
    'never throws on a malformed body (%s)',
    (_label, body) => {
      expect(parseApiErrorBody(400, body).message).toBe('API error 400');
    },
  );
});

describe('parseApiErrorBody — masking and request id', () => {
  it('embeds the header request id for a masked body', () => {
    const r = parseApiErrorBody(502, { error: 'Internal Error', message: 'Something went wrong.' }, headers('req_1'));
    expect(r.isMasked).toBe(true);
    expect(r.requestId).toBe('req_1');
    expect(r.baseMessage).toBe('Something went wrong.');
    expect(splitRequestId(r.message)).toEqual({ message: 'Something went wrong.', requestId: 'req_1' });
  });

  it('falls back to the body request id when there is no header', () => {
    const r = parseApiErrorBody(500, { error: 'Internal Error', message: 'x', requestId: 'req_body' }, headers());
    expect(r.requestId).toBe('req_body');
  });

  it('does not embed an id in a validation error', () => {
    const r = parseApiErrorBody(400, { error: 'Request Failed', details: [{ message: 'bad' }] }, headers('req_2'));
    expect(r.isMasked).toBe(false);
    expect(r.message).toBe('bad');
  });
});

describe('formatValidationIssues', () => {
  it('lists up to three problems and counts the rest', () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({ message: `problem ${i}`, path: [`f${i}`] }));
    expect(formatValidationIssues(issues)).toBe(
      'f0: problem 0; f1: problem 1; f2: problem 2 (and 2 more problems)',
    );
  });

  it('takes plain strings and drops entries with no usable message', () => {
    expect(formatValidationIssues([{ code: 'custom' }, { message: '' }, '', 'plain', 3, null])).toBe('plain');
  });
});
