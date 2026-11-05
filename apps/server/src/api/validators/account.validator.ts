import { z } from 'zod';
import { ACCOUNT_NAME_MAX_LENGTH, type CreateAccountBody } from '@magick-agency/contracts/api/platform/auth';

/**
 * The body of `POST /accounts` and `POST /super-admin/tenants/:id/accounts`
 * (`CreateAccountBody`). The name is trimmed before its length is checked, so
 * "   " is empty, and it may not carry control characters (a tab or newline would
 * render as nothing in the account switcher and still make the name unique).
 */
export const createAccountSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(ACCOUNT_NAME_MAX_LENGTH)
    .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), {
      message: 'Account name cannot contain control characters',
    }),
}) satisfies z.ZodType<CreateAccountBody>;
