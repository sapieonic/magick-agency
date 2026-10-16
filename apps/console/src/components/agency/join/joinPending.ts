/**
 * Which async action on the invite page is in flight. One value, so nothing can
 * double-submit: every control on the page is disabled while this is non-null.
 */
export type JoinPending = null | 'google' | 'create' | 'sign_in' | 'confirm' | 'decline';
