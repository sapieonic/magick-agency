import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type {
  AgencyCampaignTemplateInUseError,
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { CapabilityUnavailable } from '../../../components/common/CapabilityUnavailable';
import { PageDescription } from '../../../components/common/PageDescription';
import {
  archiveCampaignTemplate,
  listCampaignTemplates,
  restoreCampaignTemplate,
  setCampaignTemplateDefault,
} from '../../../api/campaignTemplates';
import { errorCode } from '../../../utils/agencyErrors';
import { ORGANISATION_CAMPAIGN_TEMPLATES_PATH, campaignTemplatePath } from '../../../utils/consoleNav';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { actorLabel, changedLine, formatStamp, templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { trackAgencyCampaignTemplateAction } from '../../../analytics/events';
import { useTemplatesAccess } from '../../../components/agency/campaignTemplates/useTemplatesAccess';
import { NewTemplateDialog, type NewTemplateStart } from '../../../components/agency/campaignTemplates/NewTemplateDialog';
import { EffectiveStartCard } from '../../../components/agency/campaignTemplates/EffectiveStartCard';
import { useTemplateSectionKeys } from '../../../components/agency/campaignTemplates/useTemplateSectionKeys';
import styles from '../../../components/agency/campaignTemplates/CampaignTemplates.module.css';

type View = 'live' | 'archived';

/**
 * Settings › Campaign templates (`docs/campaign-templates.md` §7), for the account
 * (`scope="account"`) or the organisation (`scope="organisation"`). Each template with its
 * default badge, what an account template is based on, the sections it sets, who changed it last
 * and its version, and Edit, Make default and Archive. The account's page also lists the
 * organisation's templates, read-only. "Archived" lists archived ones, with Restore; "New
 * template" starts one from the built-in settings, the Collections set, a template or a campaign.
 *
 * The account's page opens on what a new campaign of the account starts from now
 * (`EffectiveStartCard`, L4), and each organisation template has View (read-only). Rows show only
 * once the list of the view shown has been read: switching views never shows the other view's rows
 * with this view's actions (U5).
 */
export default function CampaignTemplatesPage({ scope }: { scope: AgencyCampaignTemplateScope }) {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const access = useTemplatesAccess();
  const allowed = scope === 'organisation' ? access.manageOrganisation : access.manage;
  const [view, setView] = useState<View>('live');
  const sections = useTemplateSectionKeys(scope);
  const [newOpen, setNewOpen] = useState(false);
  const [archiving, setArchiving] = useState<AgencyCampaignTemplateSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Moves after anything that can change what new campaigns start from: the card reads again. */
  const [chainVersion, setChainVersion] = useState(0);

  // Each read says which view it is, so rows are shown only under their own view's actions (U5).
  const fetchTemplates = useCallback(
    async () => ({
      view,
      templates: await listCampaignTemplates(tenantId ?? undefined, accountId ?? undefined, { archived: view === 'archived' }),
    }),
    [tenantId, accountId, view],
  );
  const list = useAsyncResource<{ view: View | null; templates: AgencyCampaignTemplateSummary[] }>(fetchTemplates, {
    initialData: { view: null, templates: [] },
    errorMessage: 'Could not load the templates.',
    enabled: allowed && Boolean(tenantId && accountId),
  });

  if (!allowed) return <CapabilityUnavailable />;

  const rows = list.data.view === view ? list.data.templates : [];
  const shown = list.data.view === view;
  const mine = rows.filter((t) => t.scope === scope);
  const fromOrganisation = scope === 'account' ? rows.filter((t) => t.scope === 'organisation') : [];

  const act = async (template: AgencyCampaignTemplateSummary, action: 'make_default' | 'clear_default' | 'restore') => {
    setBusy(true);
    setActionError(null);
    try {
      if (action === 'restore') await restoreCampaignTemplate(template.id, scope, tenantId ?? undefined, accountId ?? undefined);
      else await setCampaignTemplateDefault(template.id, scope, action === 'make_default', tenantId ?? undefined, accountId ?? undefined);
      trackAgencyCampaignTemplateAction({ scope, action });
      showToast(defaultToast(scope, action, template.name), 'success');
      setChainVersion((n) => n + 1);
      await list.reload();
    } catch (err) {
      setActionError(templateRefusal(err, 'Could not change the template.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmArchive = async () => {
    if (!archiving) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await archiveCampaignTemplate(archiving.id, scope, tenantId ?? undefined, accountId ?? undefined);
      trackAgencyCampaignTemplateAction({ scope, action: 'archive' });
      showToast(
        res.default_cleared
          ? `“${archiving.name}” archived. ${scope === 'organisation'
            ? 'The organisation has no default now, so accounts with no default of their own start new campaigns from the built-in settings.'
            : 'This account has no default now, so its new campaigns start from the organisation default, or the built-in settings.'}`
          : `“${archiving.name}” archived.`,
        'success',
      );
      setChainVersion((n) => n + 1);
      await list.reload();
    } catch (err) {
      if (errorCode(err) === 'campaign_template_in_use') {
        const using = ((err as { details?: AgencyCampaignTemplateInUseError }).details?.templates ?? [])
          .map((t) => (t.account_name ? `${t.name} (${t.account_name})` : t.name));
        setActionError(
          using.length > 0
            ? `These account templates are based on “${archiving.name}”: ${using.join(', ')}. Base them on another template first.`
            : templateRefusal(err, ''),
        );
      } else setActionError(templateRefusal(err, 'Could not archive the template.'));
    } finally {
      setBusy(false);
      setArchiving(null);
    }
  };

  const start = (startFrom: NewTemplateStart) => {
    setNewOpen(false);
    navigate(campaignTemplatePath(scope, 'new'), { state: { start: startFrom } });
  };

  const row = (t: AgencyCampaignTemplateSummary, editable: boolean) => (
    <li key={t.id} className={styles.row} data-testid={`template-row-${t.id}`}>
      <div className={styles.rowText}>
        <p className={styles.name}>
          {t.name}
          {t.is_default && view === 'live' ? (
            <span className={styles.badge}>{t.scope === 'organisation' ? 'Organisation default' : 'Account default'}</span>
          ) : null}
        </p>
        {t.description ? <p className={styles.description}>{t.description}</p> : null}
        {t.scope === 'account' ? (
          <p className={styles.meta}>
            {t.based_on
              ? `Based on ${t.based_on.name}${t.based_on.archived ? ' (archived)' : ''}`
              : 'Follows the organisation’s default'}
          </p>
        ) : null}
        {t.sections_set.length > 0 ? (
          <ul className={styles.chips} aria-label="Sections it sets">
            {t.sections_set.map((k) => (
              <li key={k} className={styles.chip}>
                {SECTION_LABELS[k]}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>Sets nothing of its own yet.</p>
        )}
        <p className={styles.muted}>
          {view === 'archived' && t.archived_at
            ? `Archived${actorLabel(t.archived_by) ? ` by ${actorLabel(t.archived_by)}` : ''} on ${formatStamp(t.archived_at)} · version ${t.version}`
            : changedLine(t)}
        </p>
      </div>
      {!editable && view === 'live' ? (
        // An organisation template opens read-only from an account's page (L4).
        <div className={styles.actions}>
          <Link className="btn-secondary" to={campaignTemplatePath('account', t.id)} aria-label={`View ${t.name}`}>
            View
          </Link>
        </div>
      ) : null}
      {editable ? (
        <div className={styles.actions}>
          {view === 'archived' ? (
            <button type="button" className="btn-secondary" onClick={() => void act(t, 'restore')} disabled={busy} aria-label={`Restore ${t.name}`}>
              Restore
            </button>
          ) : (
            <>
              <Link className="btn-secondary" to={campaignTemplatePath(scope, t.id)} aria-label={`Edit ${t.name}`}>
                Edit
              </Link>
              {t.is_default ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void act(t, 'clear_default')}
                  disabled={busy}
                  aria-label={`Stop using ${t.name} as the default`}
                >
                  Stop using as default
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void act(t, 'make_default')}
                  disabled={busy}
                  aria-label={`Make ${t.name} the default`}
                >
                  Make default
                </button>
              )}
              <button type="button" className="btn-secondary" onClick={() => setArchiving(t)} disabled={busy} aria-label={`Archive ${t.name}`}>
                Archive
              </button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );

  return (
    <div className={styles.page}>
      <PageHeader
        title={scope === 'organisation' ? 'Organisation campaign templates' : 'Campaign templates'}
        actions={
          view === 'live' ? (
            <button type="button" className="btn-primary" onClick={() => setNewOpen(true)}>
              <Plus size={15} aria-hidden="true" /> New template
            </button>
          ) : undefined
        }
      />
      <PageDescription
        pageKey={scope === 'organisation' ? 'organisation-campaign-templates' : 'campaign-templates'}
        description={
          scope === 'organisation'
            ? 'Settings every account’s new campaigns can start from. The default is where a new campaign starts when its account has no default of its own. Changing a template never changes a campaign that already exists.'
            : 'Settings this account’s new campaigns start from. New campaign opens on the default; anyone creating a campaign can pick another or change anything. Changing a template never changes a campaign that already exists.'
        }
      />

      {scope === 'account' ? <EffectiveStartCard version={chainVersion} /> : null}

      {/* A filter of one list, as the campaign list's status filter: pressed buttons, not tabs (CTC9). */}
      <div className={styles.toolbar} role="group" aria-label="Which templates">
        {(['live', 'archived'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            className={view === v ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setView(v)}
          >
            {v === 'live' ? 'Templates' : 'Archived'}
          </button>
        ))}
      </div>

      {actionError ? <ErrorAlert message={actionError} /> : null}
      {list.error ? <ErrorAlert message={list.error} onRetry={() => void list.reload()} /> : null}
      {list.loading && !shown ? <LoadingSpinner /> : null}

      {shown ? (
        <>
          {mine.length === 0 && !list.error ? (
            <p className={styles.muted} data-testid="templates-empty">
              {view === 'archived'
                ? 'No archived templates.'
                : scope === 'organisation'
                  ? 'The organisation has no templates yet.'
                  : 'This account has no templates yet. New campaigns start from the organisation’s default, or the built-in settings.'}
            </p>
          ) : (
            <ul className={styles.list} aria-label={scope === 'organisation' ? 'Organisation templates' : 'This account’s templates'}>
              {mine.map((t) => row(t, true))}
            </ul>
          )}
          {scope === 'account' && view === 'live' ? (
            <section aria-labelledby="templates-from-organisation">
              <h2 className={styles.heading} id="templates-from-organisation">
                From the organisation
              </h2>
              {fromOrganisation.length === 0 ? (
                <p className={styles.muted}>The organisation has no templates.</p>
              ) : (
                <ul className={styles.list} aria-labelledby="templates-from-organisation">
                  {fromOrganisation.map((t) => row(t, false))}
                </ul>
              )}
              {access.manageOrganisation ? (
                <p className={styles.muted}>
                  <Link to={ORGANISATION_CAMPAIGN_TEMPLATES_PATH}>Manage the organisation’s templates</Link>
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <NewTemplateDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        scope={scope}
        templates={scope === 'organisation' ? mine : rows}
        sections={sections}
        onStart={start}
      />
      <ConfirmDialog
        open={archiving !== null}
        title={archiving ? `Archive “${archiving.name}”?` : 'Archive'}
        message={`It moves to Archived with its versions, and can be restored. Campaigns made from it are not changed.${
          archiving?.is_default ? ' New campaigns stop starting from it.' : ''
        }`}
        confirmLabel="Archive"
        danger
        disabled={busy}
        onConfirm={() => void confirmArchive()}
        onCancel={() => setArchiving(null)}
      />
    </div>
  );
}

/**
 * What Make default, Stop using as default and Restore change, said exactly (CT10's chain: the
 * account's default, else the organisation's, else the built-in settings).
 */
function defaultToast(scope: AgencyCampaignTemplateScope, action: 'make_default' | 'clear_default' | 'restore', name: string): string {
  if (action === 'restore') return `“${name}” restored.`;
  if (scope === 'organisation') {
    return action === 'make_default'
      ? `“${name}” is now the organisation default. New campaigns start from it in accounts with no default of their own.`
      : `“${name}” is no longer the organisation default. Accounts with no default of their own now start new campaigns from the built-in settings.`;
  }
  return action === 'make_default'
    ? `“${name}” is now this account’s default. New campaigns in this account start from it.`
    : `“${name}” is no longer this account’s default. New campaigns in this account start from the organisation default, or the built-in settings.`;
}
