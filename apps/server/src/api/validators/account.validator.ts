import { z } from 'zod';
import { ACCOUNT_NAME_MAX_LENGTH, type CreateAccountBody } from '@magick-agency/contracts/api/platform/auth';

/**
 * The body of `POST /accounts` and `POST /super-admin/tenants/:id/accounts`
 * (`CreateAccountBody`). The name is trimmed before its length is checked, so "   " is
 * empty, and it may not carry control or invisible format characters (`\p{Cc}`,
 * `\p{Cf}`: tabs, newlines, zero-width spaces, bidi overrides) or line and paragraph
 * separators. Each would render as nothing, or reorder the text, in the account switcher
 * while still making the name differ from a visible twin.
 */
export const createAccountSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(ACCOUNT_NAME_MAX_LENGTH)
    .refine((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), {
      message: 'Account name cannot contain control or invisible characters',
    }),
}) satisfies z.ZodType<CreateAccountBody>;
