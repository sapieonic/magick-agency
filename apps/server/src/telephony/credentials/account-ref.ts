// The width of `telephony_credentials.account_ref` (VARCHAR(100), migration 0002), in a leaf
// module so a carrier's credential spec can cap its account ref field without importing the
// spec registry that lists it.

/**
 * The longest account ref a credential may have. A spec's public schema caps the field its
 * `accountRef` is made from at this; the credential service refuses a longer ref as a field
 * error besides, so a spec that forgets is a 400, never a Postgres 22001 and a 500.
 */
export const TELEPHONY_ACCOUNT_REF_MAX_LENGTH = 100;
