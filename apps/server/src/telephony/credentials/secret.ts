import { inspect } from 'node:util';

/**
 * Holds a decrypted secret in memory and refuses to print it. `JSON.stringify`, pino,
 * `console.log`, `util.inspect` and template strings all see `[REDACTED]`; only an
 * explicit `reveal()` at the point of use (an Authorization header, an HMAC key)
 * returns the value. The value lives in a private field, so it is not an enumerable
 * property either.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }

  [inspect.custom](): string {
    return 'Secret([REDACTED])';
  }
}

/** The last four characters of a secret, the most the console ever shows. */
export function secretHint(value: string): string {
  return value.length <= 8 ? '' : value.slice(-4);
}
