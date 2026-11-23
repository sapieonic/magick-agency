import type { ReactNode } from 'react';
import type { AgencyCampaignTemplateSectionKey } from '@magick-agency/contracts/api/agency/campaign-templates';

/**
 * What the page shows at the heading of the block that edits one settings section, by section
 * (New campaign: where the section came from and its Reset, CS18). A step places each key it owns
 * and knows nothing of what they say; a key with nothing to show renders nothing.
 */
export type SetupSectionSources = Partial<Record<AgencyCampaignTemplateSectionKey, ReactNode>>;
