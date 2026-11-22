import { useEffect, useState } from 'react';
import { getCampaignInboundDefaultRoutes } from '../api/callSettings';

/**
 * The inbound routes that file unknown callers under a campaign (`docs/call-log.md` §5), by
 * name, read while `open` (a Stop or Archive confirmation is up) so the dialog can say what
 * stopping it leaves behind. Empty until the read answers, and when it fails: the warning is
 * advice, and one that could not be read never holds up Stop.
 */
export function useUnknownCallerRoutes(
  campaignId: string | undefined,
  tenantId: string | null,
  accountId: string | null,
  open: boolean,
): string[] {
  const [found, setFound] = useState<{ campaignId: string; names: string[] } | null>(null);
  useEffect(() => {
    if (!open || !campaignId || !tenantId || !accountId) return undefined;
    let current = true;
    getCampaignInboundDefaultRoutes(campaignId, tenantId, accountId)
      .then((routes) => {
        if (current) setFound({ campaignId, names: routes.map((r) => r.name) });
      })
      .catch(() => {
        if (current) setFound({ campaignId, names: [] });
      });
    return () => {
      current = false;
    };
  }, [open, campaignId, tenantId, accountId]);
  return open && found && found.campaignId === campaignId ? found.names : [];
}
