import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import type { AgencyCampaignTemplateScope } from '@magick-agency/contracts/api/agency/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { useGovernance } from '../../../contexts/GovernanceContext';
import { useAgencyCarriers } from '../../../hooks/useAgencyCarriers';
import { useUnsavedChangesGuard } from '../../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog } from '../../../components/agency/UnsavedChangesBar';
import { CapabilityUnavailable } from '../../../components/common/CapabilityUnavailable';
import { usePageCrumbs } from '../../../components/layout/PageCrumbs';
import { AGENCY_ANALYTICS_CAPABILITY, AGENCY_RECORDING_CAPABILITY } from '../../../utils/agencyCampaignRecording';
import { CAMPAIGN_TEMPLATES_PATH, ORGANISATION_CAMPAIGN_TEMPLATES_PATH, campaignTemplatePath } from '../../../utils/consoleNav';
import { changedLine } from '../../../utils/agency/campaignTemplates/templateCopy';
import { CopyFromCampaignDialog } from '../../../components/agency/campaignTemplates/CopyFromCampaignDialog';
import { TemplateHistory } from '../../../components/agency/campaignTemplates/TemplateHistory';
import { ApplyToDraftsDialog } from '../../../components/agency/campaignTemplates/ApplyToDraftsDialog';
import { TemplateEditorForm } from '../../../components/agency/campaignTemplates/TemplateEditorForm';
import { useTemplateEditor } from '../../../components/agency/campaignTemplates/useTemplateEditor';
import { useTemplateSectionKeys } from '../../../components/agency/campaignTemplates/useTemplateSectionKeys';
import { useTemplatesAccess } from '../../../components/agency/campaignTemplates/useTemplatesAccess';
import type { NewTemplateStart } from '../../../components/agency/campaignTemplates/NewTemplateDialog';
import styles from '../../../components/agency/campaignTemplates/CampaignTemplates.module.css';

/**
 * Settings › Campaign templates › one template (`docs/campaign-templates.md` §7): the form
 * (`TemplateEditorForm`, one card per section), its state and saving (`useTemplateEditor`, whose
 * reads are `useTemplateEditorData`), and around them the header, the conflict banner ("Reload the
 * latest version", CT6), History, Copy from a campaign, Apply to draft campaigns and the
 * unsaved-changes guard. This page only composes them.
 */
export default function CampaignTemplateEditorPage({ scope }: { scope: AgencyCampaignTemplateScope }) {
  const { id = 'new' } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { accountId, accounts } = useTenant();
  const { showToast } = useToast();
  const access = useTemplatesAccess();
  const allowed = scope === 'organisation' ? access.manageOrganisation : access.manage;
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const { carriers } = useAgencyCarriers({ enabled: allowed && scope === 'account' });
  const listPath = scope === 'organisation' ? ORGANISATION_CAMPAIGN_TEMPLATES_PATH : CAMPAIGN_TEMPLATES_PATH;
  // What a new template starts from, handed over by the list's "New template" (router state).
  const [start] = useState(() => (location.state as { start?: NewTemplateStart } | null)?.start ?? null);
  const visible = useTemplateSectionKeys(scope);
  const editor = useTemplateEditor({ scope, id, enabled: allowed, start, visible });
  const { template } = editor.data;

  const [copyOpen, setCopyOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);
  const guard = useUnsavedChangesGuard(editor.dirty && goTo === null);

  // A navigation asked for by a save, once the guard has let go.
  useEffect(() => {
    if (goTo === null) return;
    navigate(goTo, { replace: true });
    setGoTo(null);
  }, [goTo, navigate]);

  usePageCrumbs(template ? [{ label: scope === 'organisation' ? 'Organisation campaign templates' : 'Campaign templates', to: listPath }, { label: template.name }] : null);

  if (!allowed) return <CapabilityUnavailable />;
  if (editor.data.loading || (editor.form === null && !editor.data.loadError)) return <LoadingSpinner />;
  if (editor.data.loadError || !editor.ready) {
    return (
      <div className={styles.page}>
        <PageHeader title={scope === 'organisation' ? 'Organisation campaign template' : 'Campaign template'} />
        <ErrorAlert message={editor.data.loadError ?? 'Could not load this template.'} onRetry={editor.data.reload} />
      </div>
    );
  }

  const save = async () => {
    const saved = await editor.save();
    if (saved && editor.isNew) setGoTo(campaignTemplatePath(scope, saved.id));
  };
  // Apply writes this account's drafts: on the organisation's page, say which account that is (C7).
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? null;

  return (
    <div className={styles.page}>
      <PageHeader
        title={editor.isNew ? (scope === 'organisation' ? 'New organisation campaign template' : 'New campaign template') : template!.name}
        subtitle={template ? changedLine(template) : undefined}
        actions={
          <div className={styles.toolbar}>
            <button type="button" className="btn-secondary" onClick={() => setCopyOpen(true)}>
              Copy from a campaign…
            </button>
            {template ? (
              <>
                <button type="button" className="btn-secondary" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}>
                  History
                </button>
                <button type="button" className="btn-secondary" onClick={() => setApplyOpen(true)} disabled={editor.dirty}>
                  Apply to draft campaigns…
                </button>
              </>
            ) : null}
          </div>
        }
      />
      <p className={styles.muted}>
        {scope === 'organisation'
          ? 'Every account can start new campaigns from this template. A section left on the built-in settings uses them.'
          : 'New campaigns of this account can start from this template. A section you do not set comes from the organisation template it is based on, or the built-in settings.'}{' '}
        Changing a template never changes a campaign that already exists. <Link to={listPath}>All templates</Link>
      </p>

      {editor.conflict ? (
        <div className={styles.banner} role="alert" data-testid="template-conflict">
          <p>Someone else saved this template after you opened it. Your changes are not saved.</p>
          <div>
            <button type="button" className="btn-primary" onClick={editor.reloadLatest}>
              Reload the latest version
            </button>
          </div>
        </div>
      ) : editor.saveError ? (
        <ErrorAlert message={editor.saveError} />
      ) : null}

      {editor.notice ? (
        <p className={styles.banner} role="status" data-testid="template-notice">
          {editor.notice}
        </p>
      ) : null}

      {historyOpen && template ? (
        <section className={styles.card} aria-label="History">
          <h2 className={styles.cardTitle}>History</h2>
          <TemplateHistory templateId={template.id} current={{ version: template.version, sections: template.sections }} />
        </section>
      ) : null}

      <TemplateEditorForm
        editor={editor}
        scope={scope}
        visible={visible}
        recordingEnabled={isCapabilityEnabled(AGENCY_RECORDING_CAPABILITY)}
        analyticsEnabled={isCapabilityEnabled(AGENCY_ANALYTICS_CAPABILITY)}
        carriers={carriers}
        onSave={() => void save()}
      />

      <CopyFromCampaignDialog
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        onCopy={(campaign) => {
          editor.copyCampaign(campaign);
          setCopyOpen(false);
          showToast('Settings copied from the campaign. Check them, then save the template.', 'success');
        }}
        note="Every section shown here is set from the campaign’s settings. Nothing is saved until you save the template."
      />
      {template ? (
        <ApplyToDraftsDialog
          open={applyOpen}
          onClose={() => setApplyOpen(false)}
          template={{ id: template.id, name: template.name, version: template.version, scope, sections_set: template.sections_set }}
          sections={visible}
          accountName={scope === 'organisation' ? accountName : null}
          // The dialog read a newer version: the editor catches up once it closes.
          onReloaded={editor.reloadLatest}
        />
      ) : null}
      <LeaveUnsavedDialog
        guard={guard}
        message="Your changes to this template are not saved. Leave now and they are lost; Cancel keeps you here to save them."
      />
    </div>
  );
}
