/**
 * The lists whose numbers My calls masks (AS9): the station's ⋮ More → My calls today opens this
 * page with `?masked=<campaign id>` when its campaign sets `phone_display: 'masked'` (the bootstrap
 * is the only read that says so). A display choice, as on the station: the number is still on the
 * wire.
 */
export const MASKED_PARAM = 'masked';

export function maskedCampaigns(params: URLSearchParams): ReadonlySet<string> {
  return new Set(params.getAll(MASKED_PARAM).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean));
}

/** The My calls link from a station whose campaign shows numbers as `display`. */
export function myCallsPath(campaignId: string | null, display: 'full' | 'masked'): string {
  return display === 'masked' && campaignId ? `/dialer/attempts?${MASKED_PARAM}=${encodeURIComponent(campaignId)}` : '/dialer/attempts';
}
