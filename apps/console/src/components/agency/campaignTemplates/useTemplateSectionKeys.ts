import { useMemo } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { templateSectionKeys } from '../../../utils/agency/campaignTemplates/templateForm';

/**
 * The sections a `scope` template shows and may set for this reader (`templateSectionKeys`, with
 * the account's flags): the editor's cards, and what a copy may set (CTC6).
 */
export function useTemplateSectionKeys(scope: AgencyCampaignTemplateScope): AgencyCampaignTemplateSectionKey[] {
  const assignment = useFeatureFlagEnabled(AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS.assignment);
  const inbound = useFeatureFlagEnabled(AGENCY_CAMPAIGN_TEMPLATE_FLAG_GATED_SECTIONS.inbound);
  return useMemo(() => templateSectionKeys(scope, { assignment, inbound }), [scope, assignment, inbound]);
}
