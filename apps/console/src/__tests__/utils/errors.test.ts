import { describe, it, expect } from 'vitest';
import {
  REQUEST_ID_SEPARATOR,
  isMaskedErrorBody,
  extractRequestId,
  appendRequestId,
  splitRequestId,
  getErrorMessage,
  getRequestId,
  toFetchError,
} from '../../utils/errors';

const RID = 'req_abc123';

describe('isMaskedErrorBody', () => {
  it('treats any 5xx as masked regardless of body', () => {
    expect(isMaskedErrorBody(500, { message: 'boom' })).toBe(true);
    expect(isMaskedErrorBody(502, null)).toBe(true);
    expect(isMaskedErrorBody(503, undefined)).toBe(true);
  });

  it('treats masked 4xx error labels as masked', () => {
    expect(isMaskedErrorBody(400, { error: 'Request Failed', message: 'x' })).toBe(true);
    expect(isMaskedErrorBody(404, { error: 'Internal Error' })).toBe(true);
  });

  it('does NOT mask field-level validation errors (details array)', () => {
    expect(isMaskedErrorBody(400, { error: 'Request Failed', details: [{ message: 'bad' }] })).toBe(false);
  });

  it('does NOT mask Zod fieldErrors shape', () => {
    expect(
      isMaskedErrorBody(400, { error: 'Request Failed', details: { fieldErrors: { name: ['required'] } } }),
    ).toBe(false);
  });

  it('does NOT mask our own business 4xx (plain message)', () => {
    // Insufficient credits / permission denied arrive as a bare actionable message.
    expect(isMaskedErrorBody(402, { message: 'Insufficient credits' })).toBe(false);
    expect(isMaskedErrorBody(403, { error: 'Forbidden', message: 'No access' })).toBe(false);
  });
});

describe('extractRequestId', () => {
  it('reads the requestId field', () => {
    expect(extractRequestId({ requestId: RID })).toBe(RID);
  });
  it('returns undefined when absent or empty', () => {
    expect(extractRequestId({})).toBeUndefined();
    expect(extractRequestId({ requestId: '' })).toBeUndefined();
    expect(extractRequestId(null)).toBeUndefined();
    expect(extractRequestId('nope')).toBeUndefined();
  });
});

describe('appendRequestId / splitRequestId round-trip', () => {
  it('appends then splits cleanly', () => {
    const joined = appendRequestId('Something went wrong.', RID);
    expect(joined).toBe(`Something went wrong.${REQUEST_ID_SEPARATOR}${RID}`);
    expect(splitRequestId(joined)).toEqual({ message: 'Something went wrong.', requestId: RID });
  });

  it('appendRequestId is a no-op without an id', () => {
    expect(appendRequestId('msg', undefined)).toBe('msg');
  });

  it('splitRequestId leaves plain messages untouched', () => {
    expect(splitRequestId('just a message')).toEqual({ message: 'just a message' });
  });

  it('splitRequestId treats a trailing separator with no id as no id', () => {
    // Defensive: a marker with an empty tail must not yield requestId: ''.
    expect(splitRequestId(`oops${REQUEST_ID_SEPARATOR}`)).toEqual({ message: 'oops' });
  });

  it('splitRequestId uses the LAST separator (handles ids that follow body text)', () => {
    const joined = appendRequestId('see Request ID guidance', RID);
    expect(splitRequestId(joined)).toEqual({ message: 'see Request ID guidance', requestId: RID });
  });
});

describe('getErrorMessage', () => {
  it('returns the Error message unchanged (marker included)', () => {
    const err = new Error(appendRequestId('Masked.', RID));
    expect(getErrorMessage(err)).toBe(`Masked.${REQUEST_ID_SEPARATOR}${RID}`);
  });
  it('handles strings and falls back', () => {
    expect(getErrorMessage('boom')).toBe('boom');
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getErrorMessage(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('getRequestId', () => {
  it('prefers a structured requestId field', () => {
    expect(getRequestId({ requestId: RID })).toBe(RID);
  });
  it('falls back to a marker embedded in an Error message', () => {
    expect(getRequestId(new Error(appendRequestId('x', RID)))).toBe(RID);
  });
  it('returns undefined when there is nothing to read', () => {
    expect(getRequestId(new Error('plain'))).toBeUndefined();
    expect(getRequestId('string')).toBeUndefined();
  });
});

describe('toFetchError', () => {
  function res(status: number, requestId?: string): Response {
    return new Response(null, {
      status,
      headers: new Headers(requestId ? { 'x-request-id': requestId } : {}),
    });
  }

  it('embeds the request id (from header) for masked errors', () => {
    const err = toFetchError(res(502, RID), { message: 'Generic message' }, 'Upload failed');
    expect(splitRequestId(err.message)).toEqual({ message: 'Generic message', requestId: RID });
  });

  it('prefers the header over the body requestId', () => {
    const err = toFetchError(res(500, 'header-id'), { message: 'm', requestId: 'body-id' }, 'fb');
    expect(getRequestId(new Error(err.message))).toBe('header-id');
  });

  it('uses the fallback when the body has no usable message', () => {
    const err = toFetchError(res(500), {}, 'Upload failed: 500');
    expect(splitRequestId(err.message).message).toBe('Upload failed: 500');
  });

  it('does not embed an id for non-masked (validation) errors', () => {
    const err = toFetchError(res(400, RID), { error: 'Request Failed', details: [{ message: 'bad' }] }, 'fb');
    expect(splitRequestId(err.message).requestId).toBeUndefined();
  });
});
