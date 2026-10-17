/**
 * A promise that never settles — what a tenant-scoped list hook's fetcher
 * returns while the tenant (or account) it needs has not resolved yet.
 *
 * `useAsyncResource` loads on mount and has no "not yet" switch, and the hooks
 * that sit on it (`useTeam`, `useAccounts`, `usePhoneNumbers`) used to simply
 * not start a request until their scope existed, leaving `loading` true. Never
 * settling keeps exactly that: `loading` stays true, nothing is written, and the
 * moment the scope arrives the fetcher's identity changes, a real load starts,
 * and the resource's sequence guard means this one could never write even if it
 * did settle. One shared instance, so waiting costs nothing per render.
 */
const NEVER: Promise<never> = new Promise<never>(() => {});

export function awaitingScope<T>(): Promise<T> {
  return NEVER;
}
