import { z } from 'zod';
import { ACCOUNT_NAME_MAX_LENGTH, type CreateAccountBody } from '@magick-agency/contracts/api/platform/auth';

/**
 * A name people pick from a list (AA2): trimmed before its length is checked, so "   " is empty,
 * 1 to `max` characters, and no control or invisible format characters (`\p{Cc}`, `\p{Cf}`: tabs,
 * newlines, zero-width spaces, bidi overrides) or line and paragraph separators. Each would render
 * as nothing, or reorder the text, in a switcher or a picker while still making the name differ
 * from a visible twin. Account names, and campaign template names (CT13), which the New campaign
 * picker lists the same way. `what` names the thing in the refusal ("Account name").
 */
export function visibleNameSchema(max: number, what: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), {
      message: `${what} cannot contain control or invisible characters`,
    });
}

/**
 * The body of `POST /accounts` and `POST /super-admin/tenants/:id/accounts`
 * (`CreateAccountBody`): the name by {@link visibleNameSchema}.
 */
export const createAccountSchema = z.object({
  name: visibleNameSchema(ACCOUNT_NAME_MAX_LENGTH, 'Account name'),
}) satisfies z.ZodType<CreateAccountBody>;
