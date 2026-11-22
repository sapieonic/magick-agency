import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type { AgencyCampaignTemplateEffective } from '@magick-agency/contracts/api/agency/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getEffectiveCampaignTemplate } from '../../../api/campaignTemplates';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { SOURCE_CHIP_LABELS, noteSentence, sectionSummary } from '../../../utils/agency/campaignTemplates/templateCopy';
import { useTemplateSectionKeys } from './useTemplateSectionKeys';
import styles from './CampaignTemplates.module.css';

/**
 * The top of an account's Settings › Campaign templates (L4): what a new campaign of this account
 * starts from now, read from `GET /campaign-templates/effective` (the account's default chain: its
 * default, else the organisation's, else the built-in settings). The template's name, or "Built-in
 * settings", then each shown section in one line with where it comes from, and the notes of the
 * filling-in as sentences. Numbers the chain leaves on built-in are each campaign's own (U8).
 *
 * `version` changes after anything on the page that can move the chain (a default made or
 * cleared, an archive, a restore), so the card reads it again.
 */
export function EffectiveStartCard({ version }: { version: number }) {
  const { tenantId, accountId } = useTenant();
  const sections = useTemplateSectionKeys('account');
  const fetchEffective = useCallback(
    () => getEffectiveCampaignTemplate(null, tenantId ?? undefined, accountId ?? undefined),
    // `version` is what makes the read happen again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, accountId, version],
  );
  const effective = useAsyncResource<AgencyCampaignTemplateEffective | null>(fetchEffective, {
    initialData: null,
    errorMessage: 'Could not read what new campaigns start from.',
    enabled: Boolean(tenantId && accountId),
  });
  const now = effective.data;

  return (
    <section className={styles.card} aria-labelledby="effective-start-title" data-testid="effective-start">
      <div>
        <h2 className={styles.cardTitle} id="effective-start-title">
          New campaigns in this account start from
        </h2>
        {now ? (
          <p className={styles.effectiveName} data-testid="effective-start-name">
            {now.template
              ? `${now.template.name}${now.template.scope === 'organisation' ? ' (organisation template)' : ''}`
              : 'Built-in settings'}
            {now.based_on ? <span className={styles.muted}>{` · based on ${now.based_on.name}`}</span> : null}
          </p>
        ) : null}
      </div>
      {effective.error ? (
        <p className={styles.fieldError} role="alert">
          {effective.error}{' '}
          <button type="button" className={styles.linkButton} onClick={() => void effective.reload()}>
            Try again
          </button>
        </p>
      ) : null}
      {!now && effective.loading ? <p className={styles.muted}>Reading what new campaigns start from…</p> : null}
      {now ? (
        <>
          <ul className={styles.effective} aria-label="Each section">
            {sections.map((key) => {
              const source = now.sources[key];
              const ownNumbers = key === 'numbers' && source === 'builtin';
              return (
                <li key={key} className={styles.effectiveRow} data-testid={`effective-${key}`}>
                  <span className={styles.diffLabel}>{SECTION_LABELS[key]}</span>
                  <span className={styles.source} data-source={source}>
                    {ownNumbers ? 'Each campaign' : SOURCE_CHIP_LABELS[source]}
                  </span>
                  <span className={styles.diffSide}>
                    {ownNumbers ? 'Each new campaign picks its own numbers' : sectionSummary(key, now.config)}
                  </span>
                </li>
              );
            })}
          </ul>
          {now.notes.length > 0 ? (
            <ul className={styles.notes} data-testid="effective-start-notes">
              {now.notes.map((note, i) => (
                <li key={`${note.code}-${note.section}-${i}`}>{noteSentence(note)}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
