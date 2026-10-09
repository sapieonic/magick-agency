import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch } from 'lucide-react';
import { campaignLineage } from '../../api/agencyCampaigns';
import { lineageStripModel } from '../../utils/agencyCampaignLineage';
import type { AgencyCampaignLineage } from '../../types/agency-campaign';
import styles from './CampaignLineageStrip.module.css';

/**
 * "Retry 1 of Q3 Winback" on a child, "Retried 2 times" on a parent — with
 * every other pass one click away.
 *
 * ── It fetches on every campaign, and that is deliberate ────────────────────
 * A campaign that HAS been retried carries `retry_generation: 0` and
 * `parent_campaign_id: null`, exactly like a campaign that never was — nothing
 * on its own row distinguishes a parent from an ordinary campaign, so there is
 * no cheaper precondition to check. `retry_generation > 0` would gate only the
 * child's half of the feature, and the parent's half is the one a supervisor
 * reaches first: they are looking at the campaign that finished.
 *
 * What that costs is one small read per campaign page view, against a route
 * whose answer is a handful of rows on an indexed key. What it buys is that the
 * fact is never missing from the surface it belongs on.
 *
 * ── Every failure renders nothing ───────────────────────────────────────────
 * A master that predates the route answers 404; a core outage answers 5xx. In
 * both cases the campaign page is intact and the honest thing to show is what
 * this build showed before the feature existed. An error strip here would put a
 * failure notice at the top of every campaign in the product for the length of
 * a deploy, about a line that is empty for almost all of them anyway.
 */
export interface CampaignLineageStripProps {
  campaignId: string;
  tenantId: string | undefined;
  accountId: string | undefined;
}

export function CampaignLineageStrip({
  campaignId,
  tenantId,
  accountId,
}: CampaignLineageStripProps) {
  const [lineage, setLineage] = useState<AgencyCampaignLineage | null>(null);

  useEffect(() => {
    if (!tenantId || !accountId) return undefined;
    let live = true;
    // Cleared before the read, not after it: without this, navigating from a
    // child to an unrelated campaign leaves the previous chain on screen until
    // the new answer lands, under the new campaign's name.
    setLineage(null);
    campaignLineage(campaignId, tenantId, accountId)
      .then((result) => {
        if (live) setLineage(result);
      })
      .catch(() => {
        if (live) setLineage(null);
      });
    return () => {
      live = false;
    };
  }, [campaignId, tenantId, accountId]);

  const model = lineageStripModel(lineage, campaignId);
  if (!model) return null;

  return (
    <nav className={styles.strip} aria-label="Retry campaigns" data-testid="campaign-lineage">
      <span className={styles.headline}>
        <GitBranch size={14} aria-hidden="true" />
        {model.headline}
      </span>
      <ul className={styles.chain}>
        {model.entries.map((entry) => (
          <li key={entry.id}>
            {entry.isCurrent ? (
              /*
                The campaign being read is a marker, not a link to itself.
                `aria-current="page"` rather than a colour alone, matching
                `CampaignTabs` — the strip is a set of destinations and one of
                them is where you already are.
              */
              <span className={styles.entryCurrent} aria-current="page">
                {entry.position}
              </span>
            ) : (
              <Link
                to={`/agency/campaigns/${entry.id}`}
                className={styles.entry}
                /* The name and the size, because the position alone ("Retry 2")
                   does not say which list it worked on or how big it was. */
                title={`${entry.name} — ${entry.contactsTotal.toLocaleString()} contacts`}
              >
                {entry.position}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
