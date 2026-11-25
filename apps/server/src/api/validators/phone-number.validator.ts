import { z } from 'zod';

// No telephony-provider schemas: the migrations seed the `telephony_providers` rows, and
// there is no provider CRUD.

export const createPhoneNumberSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  provider_id: z.string().uuid(),
  label: z.string().max(255).optional(),
  capabilities: z.array(z.string()).optional(),
  region: z.string().max(10).optional(),
  max_concurrent_calls: z.number().int().min(1),
  notes: z.string().optional(),
  // CR6: the tenant credential to pin the number to (a carrier whose tenant-account numbers
  // are added by hand). Omitted or null: the service's own account. The route judges it.
  telephony_credential_id: z.string().uuid().nullable().optional(),
  // No `pool_eligible` on the wire: there is no pooled number. The column stays
  // in the schema at its default `false`; an unknown key is stripped by Zod, so a
  // client sending it is ignored, not refused.
});

export const updatePhoneNumberSchema = z.object({
  label: z.string().max(255).optional(),
  notes: z.string().optional(),
  status: z.enum(['active', 'retired', 'deleted']).optional(),
  max_concurrent_calls: z.number().int().min(1).optional(),
  // No `pool_eligible`, as in the create schema. No `provider_id` or `telephony_credential_id`
  // either: a number's carrier and its pin never change after it is created (CR6, CR7); Zod
  // strips them, so a client sending them changes nothing.
});

export const assignPhoneNumberSchema = z.object({
  tenant_id: z.string().uuid(),
  is_default: z.boolean().optional().default(false),
});

// No number-tagging schema: there is no tenant-facing tagging route (an untagged
// number is available to every account of its tenant — `findAvailableForAccount`).
