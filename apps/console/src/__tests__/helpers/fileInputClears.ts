/**
 * Count the times a file input's value is set to `''`. A browser fires no `change` when the same
 * file is chosen again unless the input was cleared after the last pick, which is how a refused
 * upload is retried. jsdom fires `change` either way and always reads a file input's value as
 * `''`, so the clear itself is what a test can see.
 */
export function watchFileInputClears(input: HTMLInputElement): () => number {
  let clears = 0;
  const own = Object.getOwnPropertyDescriptor(input, 'value');
  const base = own ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return base.get!.call(this);
    },
    set(next: string) {
      if (next === '') clears += 1;
      base.set!.call(this, next);
    },
  });
  return () => clears;
}
