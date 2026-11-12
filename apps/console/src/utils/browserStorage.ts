/** `window.localStorage`, or `undefined` where there is none or reading it throws (blocked site data). */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
