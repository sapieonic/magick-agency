import { z } from 'zod';

export const sessionRequestSchema = z.object({
  id_token: z.string().min(1, 'id_token is required'),
  phone_number: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
});

export type SessionRequest = z.infer<typeof sessionRequestSchema>;
