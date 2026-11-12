/**
 * The device fields the public layer accepts on the campaign join, the soft-phone open and the
 * station-token mint (OS3, `@magick-agency/contracts/agency` `station-device.ts`). Validated here,
 * at the edge: a `device_id` that does not match the pattern is a 400 and never reaches the session
 * row. Both are optional, so an older client's body (none of them) is unchanged.
 */
import { z } from 'zod';
import { AGENCY_STATION_DEVICE_ID_PATTERN } from '@magick-agency/contracts/agency';

export const stationDeviceSchema = z.object({
  device_id: z.string().regex(AGENCY_STATION_DEVICE_ID_PATTERN).optional(),
  take_over: z.boolean().optional(),
});
