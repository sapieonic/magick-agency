/**
 * How long a call's webhook token stays valid after the call ends (Q6): the carrier's
 * terminal and recording callbacks arrive after the row is finalized. Shared by the
 * bridge (token TTL) and the credential store (a revoked credential's secrets are not
 * shredded while a call that ended inside this window may still be checked with them).
 */
export const WEBHOOK_TOKEN_POST_END_GRACE_SECONDS = 2 * 60 * 60;
