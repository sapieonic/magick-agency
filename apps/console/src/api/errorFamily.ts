import { ApiError } from './client';
import { errorCode } from '../utils/agencyErrors';
import { getErrorMessage } from '@magick-agency/web-ui/errors';

/**
 * The error helpers a read's client shares with the others of its kind (Compare agents, Team
 * performance, the reports' code): which refusal code an error carries, whether the page offers
 * Try again, and the console's words for it (AS15: the server's `message` is English fallback
 * copy and is never shown for a known code).
 */

/** A refusal code reader for one family: the code when it is one of `codes`, otherwise null. */
export function familyCode<C extends string>(codes: Iterable<C>): (err: unknown) => C | null {
  const known: ReadonlySet<string> = new Set<string>(codes);
  return (err) => {
    const code = errorCode(err);
    return code !== null && known.has(code) ? (code as C) : null;
  };
}

/**
 * The words for a failure with no answer from the server at all (the network). A `fetch` that
 * fails says "Failed to fetch" or "NetworkError when attempting to fetch resource.", which is
 * the browser's English, not the console's.
 */
export const NETWORK_ERROR_MESSAGE = 'Couldn’t reach the server. Check your connection and try again.';

/** How one read's client turns what it threw into a code, a Try again and the words to show. */
export interface ErrorFamily<C extends string> {
  /** The refusal code, when it is one of the family's (or the flag gate's). */
  code: (err: unknown) => C | null;
  /**
   * A failure that can clear by itself, so the page offers Try again: one of the family's
   * `retryable` codes, any other 429 or 5xx, and a failure with no answer at all (an abort is
   * not one). Every other refusal, a 403 or a 400 with or without a code, stays until the
   * reader changes something, so asking again would only fail again.
   */
  isRetryable: (err: unknown) => boolean;
  /**
   * The words to show: the family's copy for a known code, `forbidden` for a 403 without one,
   * the client's message (or `fallback`) for any other answer, and
   * {@link NETWORK_ERROR_MESSAGE} when there was no answer.
   */
  message: (err: unknown, fallback: string) => string;
}

/**
 * One family's helpers. `messages` holds the console's words for every code the family can
 * refuse with, the flag gate's `feature_disabled` included; its keys are the codes recognised.
 */
export function errorFamily<C extends string>(family: {
  messages: Readonly<Record<C, string>>;
  retryable: readonly C[];
  forbidden: string;
}): ErrorFamily<C> {
  const code = familyCode(Object.keys(family.messages) as C[]);
  return {
    code,
    isRetryable: (err) => {
      const known = code(err);
      if (known !== null) return family.retryable.includes(known);
      if (err instanceof ApiError) return err.statusCode === 429 || err.statusCode >= 500;
      return !(err instanceof DOMException && err.name === 'AbortError');
    },
    message: (err, fallback) => {
      const known = code(err);
      if (known !== null) return family.messages[known];
      if (err instanceof ApiError) {
        if (err.statusCode === 403) return family.forbidden;
        return getErrorMessage(err, fallback);
      }
      return NETWORK_ERROR_MESSAGE;
    },
  };
}
