import { z } from 'zod';

// PORT NOTE (magick-agency): master's `createTelephonyProviderSchema` and
// `updateTelephonyProviderSchema` (incl. migration 074's
// `live_transfer_enabled`) are deleted with the telephony-provider CRUD routes:
// agency dials on its one VoiceLink account, whose `telephony_providers` row the
// baseline seeds (plan Decided #3, §3.4 "phone numbers for agency's VoiceLink
// account"). `live_transfer_enabled` is not a baseline column either (AI
// escalation only).

export const createPhoneNumberSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format'),
  provider_id: z.string().uuid(),
  label: z.string().max(255).optional(),
  capabilities: z.array(z.string()).optional(),
  region: z.string().max(10).optional(),
  max_concurrent_calls: z.number().int().min(1),
  notes: z.string().optional(),
  // PORT NOTE (magick-agency): master's `pool_eligible` (opt-in to the signup
  // pool) is removed from the wire — agency has no pooled number (plan §3.4).
  // The column stays in the schema at its default `false`; an unknown key is
  // stripped by Zod, so an old client sending it is ignored, not refused.
});

export const updatePhoneNumberSchema = z.object({
  label: z.string().max(255).optional(),
  notes: z.string().optional(),
  status: z.enum(['active', 'retired', 'deleted']).optional(),
  max_concurrent_calls: z.number().int().min(1).optional(),
  // PORT NOTE (magick-agency): `pool_eligible` removed, as in the create schema.
});

export const assignPhoneNumberSchema = z.object({
  tenant_id: z.string().uuid(),
  is_default: z.boolean().optional().default(false),
});

// PORT NOTE (magick-agency): master's `tagPhoneNumberSchema` is deleted. Its only
// caller is the tenant-facing tagging route in master's `phone-number.routes.ts`,
// which is not in agency's wire contract (an untagged number is available to
// every account of its tenant — `findAvailableForAccount`).
