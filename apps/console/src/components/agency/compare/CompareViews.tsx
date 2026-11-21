import { useId, useState, type FormEvent } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import {
  COMPARE_VIEW_NAME_MAX,
  compareMetricId,
  type AgencyCompareMetricRef,
  type AgencyCompareView,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { compareErrorMessage, createCompareView, deleteCompareView, updateCompareView } from '../../../api/compare';
import { LENS_LABELS } from '../../../utils/agency/compare/compareMetrics';
import { metricParam } from '../../../utils/agency/compare/compareUrl';
import styles from './Compare.module.css';

/**
 * Saved views (`docs/compare-agents.md` §4): a lens, metrics and trend, never agents or a window.
 * Apply one from the list (the page drops a metric whose outcomes the campaign no longer has, and
 * says so); save the page as a new view; and, on a view of one's own, save changes, share it with
 * the account's supervisors, make it the campaign's default, or delete it. Another supervisor's
 * shared view is read-only (the server answers 404 to anyone but the owner).
 */

/** What the page shows now, as a view would hold it. */
export interface CompareViewShape {
  lens: CompareLens;
  metrics: readonly AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
}

/** Whether the page differs from the view: lens, metrics (ids, labels and order) or trend. */
export function viewDiffers(view: Pick<AgencyCompareView, 'lens' | 'metrics' | 'trend'>, shape: CompareViewShape): boolean {
  if (view.lens !== shape.lens) return true;
  const a = view.metrics.map(metricParam).join('|');
  const b = shape.metrics.map(metricParam).join('|');
  if (a !== b) return true;
  const ta = view.trend ? compareMetricId(view.trend) : '';
  const tb = shape.trend ? compareMetricId(shape.trend) : '';
  return ta !== tb;
}

export interface CompareViewsProps {
  tenantId: string;
  accountId: string;
  userId: string | null;
  campaignId: string;
  campaignName: string | null;
  views: readonly AgencyCompareView[] | null;
  applied: AgencyCompareView | null;
  current: CompareViewShape;
  onApply: (view: AgencyCompareView) => void;
  /** A view was created or changed: the page re-reads the list and keeps it applied. */
  onSaved: (view: AgencyCompareView) => void;
  onDeleted: (viewId: string) => void;
}

export function CompareViews(props: CompareViewsProps) {
  const { tenantId, accountId, userId, campaignId, campaignName, views, applied, current, onApply, onSaved, onDeleted } = props;
  const { showToast } = useToast();
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectId = useId();
  const mine = applied !== null && userId !== null && applied.owner.user_id === userId;
  const dirty = applied !== null && viewDiffers(applied, current);

  const own = (views ?? []).filter((v) => userId !== null && v.owner.user_id === userId);
  const shared = (views ?? []).filter((v) => userId === null || v.owner.user_id !== userId);

  const patch = async (body: Parameters<typeof updateCompareView>[1], done: string) => {
    if (!applied) return;
    setSaving(true);
    try {
      const view = await updateCompareView(applied.id, body, tenantId, accountId);
      onSaved(view);
      showToast(done, 'success');
    } catch (err) {
      showToast(compareErrorMessage(err, 'The view couldn’t be saved. Try again.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!applied) return;
    setConfirmDelete(false);
    setSaving(true);
    try {
      await deleteCompareView(applied.id, tenantId, accountId);
      onDeleted(applied.id);
      showToast(`“${applied.name}” was deleted.`, 'success');
    } catch (err) {
      showToast(compareErrorMessage(err, 'The view couldn’t be deleted. Try again.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.views} data-testid="compare-views">
      <label className={styles.srOnly} htmlFor={selectId}>
        Saved views
      </label>
      <select
        id={selectId}
        className={styles.viewSelect}
        value={applied?.id ?? ''}
        disabled={views === null}
        onChange={(e) => {
          const view = (views ?? []).find((v) => v.id === e.target.value);
          if (view) onApply(view);
        }}
        data-testid="compare-view-select"
      >
        <option value="">{views === null ? 'Loading saved views…' : views.length ? 'Saved views' : 'No saved views yet'}</option>
        {own.length ? (
          <optgroup label="Yours">
            {own.map((v) => (
              <option key={v.id} value={v.id}>
                {v.is_campaign_default ? `${v.name} (campaign default)` : v.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {shared.length ? (
          <optgroup label="Shared with you">
            {shared.map((v) => (
              <option key={v.id} value={v.id}>
                {`${v.name} · ${v.owner.name ?? 'a supervisor'}${v.is_campaign_default ? ' (campaign default)' : ''}`}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {applied && mine ? (
        <>
          {dirty ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={() =>
                patch({ lens: current.lens, metrics: [...current.metrics], trend: current.trend }, `Changes saved to “${applied.name}”.`)
              }
            >
              Save changes
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || applied.is_campaign_default}
            title={applied.is_campaign_default ? 'A campaign default is always shared.' : undefined}
            onClick={() =>
              patch({ shared: !applied.shared }, applied.shared ? `“${applied.name}” is now yours only.` : `“${applied.name}” is shared with the account’s supervisors.`)
            }
          >
            {applied.shared ? 'Stop sharing' : 'Share'}
          </button>
          {applied.campaign_id === campaignId || applied.campaign_id === null ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={() =>
                patch(
                  applied.is_campaign_default
                    ? { is_campaign_default: false }
                    : { is_campaign_default: true, shared: true, campaign_id: campaignId },
                  applied.is_campaign_default
                    ? `“${applied.name}” is no longer the campaign’s default.`
                    : `${campaignName ?? 'This campaign'} now opens on “${applied.name}”.`,
                )
              }
            >
              {applied.is_campaign_default ? 'Remove as campaign default' : 'Make campaign default'}
            </button>
          ) : null}
          <button type="button" className="btn-secondary" disabled={saving} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        </>
      ) : null}
      {applied && !mine ? (
        <span className={styles.hint}>{`Shared by ${applied.owner.name ?? 'another supervisor'} · read-only. Save as a new view to change it.`}</span>
      ) : null}
      <button type="button" className="btn-secondary" disabled={saving} onClick={() => setDialogOpen(true)} data-testid="compare-save-view">
        Save as new view
      </button>
      {dialogOpen ? (
        <SaveViewDialog
          tenantId={tenantId}
          accountId={accountId}
          campaignId={campaignId}
          campaignName={campaignName}
          current={current}
          onClose={() => setDialogOpen(false)}
          onSaved={(view) => {
            setDialogOpen(false);
            onSaved(view);
            showToast(`Saved as “${view.name}”.`, 'success');
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this view?"
        message={applied ? `“${applied.name}” will be deleted for everyone it is shared with. The page stays as it is.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

interface SaveViewDialogProps {
  tenantId: string;
  accountId: string;
  campaignId: string;
  campaignName: string | null;
  current: CompareViewShape;
  onClose: () => void;
  onSaved: (view: AgencyCompareView) => void;
}

function SaveViewDialog({ tenantId, accountId, campaignId, campaignName, current, onClose, onSaved }: SaveViewDialogProps) {
  const ids = useId();
  const [name, setName] = useState(`${LENS_LABELS[current.lens]} view`);
  const [forCampaign, setForCampaign] = useState(true);
  const [shared, setShared] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const nameError = trimmed.length === 0 ? 'Give the view a name.' : trimmed.length > COMPARE_VIEW_NAME_MAX ? `Keep the name to ${COMPARE_VIEW_NAME_MAX} characters.` : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const view = await createCompareView(
        {
          name: trimmed,
          lens: current.lens,
          metrics: [...current.metrics],
          trend: current.trend,
          campaign_id: forCampaign || isDefault ? campaignId : null,
          shared: shared || isDefault,
          is_campaign_default: isDefault,
        },
        tenantId,
        accountId,
      );
      onSaved(view);
    } catch (err) {
      setError(compareErrorMessage(err, 'The view couldn’t be saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Save this view"
      subtitle="A view keeps the lens, the metrics and the trend. Agents and dates stay in the page’s link."
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" form={`${ids}-form`} disabled={busy}>
            {busy ? 'Saving…' : 'Save view'}
          </button>
        </>
      }
    >
      <form id={`${ids}-form`} onSubmit={submit} className={styles.checks} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-name`}>
            Name
          </label>
          <input
            id={`${ids}-name`}
            type="text"
            value={name}
            maxLength={COMPARE_VIEW_NAME_MAX}
            data-autofocus="true"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label>
          <input type="checkbox" checked={forCampaign || isDefault} disabled={isDefault} onChange={(e) => setForCampaign(e.target.checked)} />
          <span>
            {`Only for ${campaignName ?? 'this campaign'}`}
            <small>Untick to use it on any campaign. Outcomes a campaign does not have are left out when it is applied.</small>
          </span>
        </label>
        <label>
          <input type="checkbox" checked={shared || isDefault} disabled={isDefault} onChange={(e) => setShared(e.target.checked)} />
          <span>
            Share with the account’s supervisors
            <small>They can apply it but not change it.</small>
          </span>
        </label>
        <label>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span>
            {`Open ${campaignName ?? 'this campaign'} on this view`}
            <small>The campaign’s default for every supervisor. It replaces any other default.</small>
          </span>
        </label>
        {error ? (
          <p className={styles.inlineError} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
