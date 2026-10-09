import { useState, useMemo, useCallback } from 'react';
import { Plus, Sparkles, Pencil, Trash2, X, Save, Eye } from 'lucide-react';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
import { usePermission } from '../../hooks/usePermission';
import { useTenant } from '../../contexts/TenantContext';
import {
  createCallAnalysisProfile,
  updateCallAnalysisProfile,
} from '../../api/call-analysis-profiles';
import {
  PageHeader,
  PageDescription,
  StatusBadge,
  DataTable,
  ErrorAlert,
  EmptyState,
  ConfirmDialog,
} from '../../components/common';
import { formatDate } from '../../utils/format';
import { toDimensionKey } from '../../utils/snake-case';
import type { CallAnalysisProfile, AnalyticsDimension } from '../../types/call-analysis-profile';
import { MAX_ANALYSIS_DIMENSIONS } from '../../types/call-analysis-profile';
import {
  EMPTY_PROFILE_FORM,
  EMPTY_DIMENSION,
  DIMENSION_TYPE_LABELS,
  profileToForm,
  toValidDimensions,
  buildCreatePayload,
  buildUpdatePayload,
  describeDimension,
  type AnalysisProfileFormData,
  type DimensionRow,
} from './analysisProfileForm';
import styles from './AnalysisProfilesPage.module.css';

/**
 * Call summaries — the reusable definition of what we look for when summarizing
 * a dialer call. Deliberately plainer language than the prompt editor's
 * "analytics config": the audience here is the person making the calls.
 */
export default function AnalysisProfilesPage() {
  const { tenantId, accountId } = useTenant();
  const canWrite = usePermission('agency.analysis_profiles.write');
  const { profiles, loading, error, reload, remove } = useCallAnalysisProfiles();

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<CallAnalysisProfile | null>(null);
  const [form, setForm] = useState<AnalysisProfileFormData>(EMPTY_PROFILE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<CallAnalysisProfile | null>(null);
  /*
    A failed DELETE has to land somewhere the operator can see, and it did not.

    `handleDeleteConfirm` used to swallow the throw under the comment "Surfaced by
    the hook's error state" — which was simply false: the hook's `error` is written
    only by `load`'s catch, and `load()` is never reached when `remove` rejects. So
    a refusal closed the dialog, left the row in the list, and said nothing. The
    operator pressed Delete again and concluded the page was broken.

    That matters most for core's `profile_in_use_by_agency_campaign` 409, whose
    entire content IS the remedy — which campaigns depend on this profile, and that
    cloning it is the way out. It is deliberately allow-listed through master's
    error mask so the message survives the hop; having it survive the hop and then
    be dropped by the client is the same outcome as masking it, reached later.

    Page-level rather than inside `ConfirmDialog`, which takes a fixed `message`
    and has no error slot; the alert sits above the table the row is still in.
  */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const setField = useCallback(
    <K extends keyof AnalysisProfileFormData>(field: K, value: AnalysisProfileFormData[K]) => {
      setForm(prev => ({ ...prev, [field]: value }));
    },
    [],
  );

  // ── Dimension rows ─────────────────────────────────

  const addDimension = useCallback(() => {
    setForm(prev => ({
      ...prev,
      custom_dimensions: [...prev.custom_dimensions, { ...EMPTY_DIMENSION }],
    }));
  }, []);

  const updateDimension = useCallback(
    (index: number, field: keyof DimensionRow, value: string) => {
      setForm(prev => {
        const dims = [...prev.custom_dimensions];
        const dim = dims[index];
        if (!dim) return prev;
        if (field === 'description') {
          // The snake_case key is derived, never authored. Keeping it in sync as
          // the description is typed means the two can't drift.
          dims[index] = { ...dim, description: value, key: toDimensionKey(value) };
        } else if (field === 'type') {
          dims[index] = { ...dim, type: value as DimensionRow['type'] };
        } else {
          dims[index] = { ...dim, [field]: value };
        }
        return { ...prev, custom_dimensions: dims };
      });
    },
    [],
  );

  const removeDimension = useCallback((index: number) => {
    setForm(prev => ({
      ...prev,
      custom_dimensions: prev.custom_dimensions.filter((_, i) => i !== index),
    }));
  }, []);

  // ── Modal open/close ───────────────────────────────

  /*
    Both openers clear `deleteError`. `ErrorAlert` has no dismiss affordance and
    widening a shared component for one page would be the wrong trade, so the alert
    is cleared on the paths that mean the operator has moved on — and the remedy
    the 409 names IS one of them: cloning the profile, or pointing a campaign
    elsewhere, starts by opening this modal. A refusal still on screen after that
    reads as a second, current failure.
  */
  const handleOpenCreate = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_PROFILE_FORM);
    setFormError(null);
    setDeleteError(null);
    setShowModal(true);
  }, []);

  const handleOpenEdit = useCallback((profile: CallAnalysisProfile) => {
    setEditing(profile);
    setForm(profileToForm(profile));
    setFormError(null);
    setDeleteError(null);
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
    setEditing(null);
  }, []);

  // ── Save ───────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!tenantId) return;
    if (!form.name.trim()) {
      setFormError('Give this summary a name so you can pick it on the dialer.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await updateCallAnalysisProfile(
          tenantId,
          editing.id,
          buildUpdatePayload(form),
          accountId ?? undefined,
        );
      } else {
        await createCallAnalysisProfile(
          tenantId,
          buildCreatePayload(form),
          accountId ?? undefined,
        );
      }
      handleClose();
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [tenantId, accountId, form, editing, reload, handleClose]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await remove(deleteTarget.id);
    } catch (err) {
      // `ApiError.extractMessage` returns the body's `message`, so a 409 arrives
      // here as the sentence core wrote. The fallback is only for a transport
      // failure with no body at all.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete this summary setup');
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, remove]);

  // What will actually be saved — the same filtering the payload builder applies,
  // so the preview can't promise something the save then drops.
  const previewDimensions: AnalyticsDimension[] = useMemo(
    () => toValidDimensions(form.custom_dimensions),
    [form.custom_dimensions],
  );

  const atDimensionLimit = form.custom_dimensions.length >= MAX_ANALYSIS_DIMENSIONS;

  // ── Columns ────────────────────────────────────────

  const columns = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        render: (row: CallAnalysisProfile) => (
          <span className={styles.nameCell}>
            <Sparkles size={14} />
            {row.name}
          </span>
        ),
      },
      {
        key: 'description',
        label: 'Description',
        render: (row: CallAnalysisProfile) =>
          row.description ? (
            <span className={styles.descriptionCell}>{row.description}</span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>--</span>
          ),
      },
      {
        key: 'custom_dimensions',
        label: 'What we capture',
        render: (row: CallAnalysisProfile) => (
          <span className={styles.countCell}>
            {row.custom_dimensions?.length ?? 0}
          </span>
        ),
      },
      {
        key: 'is_default',
        label: '',
        render: (row: CallAnalysisProfile) =>
          row.is_default ? <StatusBadge label="Default" color="#3fcf9e" /> : null,
      },
      {
        key: 'updated_at',
        label: 'Updated',
        render: (row: CallAnalysisProfile) => (
          <span className={styles.timeCell}>{formatDate(row.updated_at)}</span>
        ),
      },
      {
        key: 'actions',
        label: '',
        render: (row: CallAnalysisProfile) => (
          <div className={styles.actionsCell}>
            {canWrite && (
              <button
                type="button"
                className={styles.iconBtn}
                title="Edit"
                aria-label={`Edit ${row.name}`}
                onClick={() => handleOpenEdit(row)}
              >
                <Pencil size={14} />
              </button>
            )}
            {canWrite && (
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Delete"
                aria-label={`Delete ${row.name}`}
                onClick={() => setDeleteTarget(row)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ),
      },
    ],
    [canWrite, handleOpenEdit],
  );

  if (error) {
    return (
      <div className={styles.page}>
        <PageHeader title="Call Summaries" />
        <ErrorAlert message={error} onRetry={reload} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Call Summaries"
        badge={profiles.length}
        actions={
          canWrite ? (
            <button type="button" className="btn-primary" onClick={handleOpenCreate}>
              <Plus size={14} />
              New summary
            </button>
          ) : undefined
        }
      />

      <PageDescription
        pageKey="analysis-profiles"
        description="After a recorded dialer call, we can write a short summary of what was said. A summary setup tells us what to look for — the specific details you want noted from every call, like whether the customer agreed to a payment plan."
        tips={[
          'Set one as the default and every recorded call uses it automatically. You can still pick a different one per call on the dialer.',
          'Telling us what these calls are about makes the summaries noticeably better — it is the single most useful thing you can fill in.',
          'Only recorded calls can be summarized. There is nothing to listen to otherwise.',
        ]}
      />

      {deleteError && <ErrorAlert message={deleteError} />}

      <div className={styles.tableSection}>
        {!loading && profiles.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={40} />}
            title="No call summaries set up yet"
            description="Create one to have us write a summary of every recorded call you make from the dialer."
            action={
              canWrite ? (
                <button type="button" className="btn-primary" onClick={handleOpenCreate}>
                  <Plus size={14} />
                  New summary
                </button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={profiles}
            loading={loading}
            keyExtractor={row => row.id}
          />
        )}
      </div>

      {/* Create / edit */}
      {showModal && (
        <div className={styles.overlay} onClick={handleClose} role="dialog" aria-modal="true">
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>
                {editing ? 'Edit call summary' : 'New call summary'}
              </h2>
              <button
                type="button"
                className={styles.modalClose}
                onClick={handleClose}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className={styles.modalBody}>
              {formError && <ErrorAlert message={formError} />}

              <div className="form-group">
                <label htmlFor="profileName">Name *</label>
                <input
                  id="profileName"
                  type="text"
                  value={form.name}
                  onChange={e => setField('name', e.target.value)}
                  placeholder="e.g. Collections calls"
                  // The name is the logical identity upstream, so an update
                  // can't change it — editing one would create a second profile.
                  disabled={!!editing}
                />
                {editing && (
                  <p className={styles.helpText}>
                    The name can't be changed. Create a new summary if you need a different one.
                  </p>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="profileDescription">Description</label>
                <input
                  id="profileDescription"
                  type="text"
                  value={form.description}
                  onChange={e => setField('description', e.target.value)}
                  placeholder="Optional — a note to help you tell your summaries apart"
                />
              </div>

              {/* The single highest-leverage quality knob for human↔human
                  transcription, so it gets prominence and an explicit "this
                  makes it better" note rather than being tucked in an advanced
                  section. */}
              <div className="form-group">
                <label htmlFor="profileContext">What are these calls about?</label>
                <textarea
                  id="profileContext"
                  value={form.context}
                  onChange={e => setField('context', e.target.value)}
                  rows={4}
                  placeholder="e.g. Our agents call customers whose loan payment is overdue, to agree a date they'll pay by."
                />
                <p className={styles.helpText}>
                  A sentence or two about who's on these calls and what they're trying to achieve.
                  This makes a real difference to how good the summaries are.
                </p>
              </div>

              <div className="form-group">
                <label>What to capture from each call</label>
                <p className={styles.helpText} style={{ marginTop: 0, marginBottom: 10 }}>
                  Optional. Specific details you want noted every time, on top of the
                  summary we always write.
                </p>
                <div className={styles.dimensionList}>
                  {form.custom_dimensions.map((dim, i) => (
                    <div key={i} className={styles.dimensionCard}>
                      <div className={styles.dimensionRow}>
                        <input
                          type="text"
                          value={dim.description}
                          onChange={e => updateDimension(i, 'description', e.target.value)}
                          placeholder="What to capture (e.g. Whether the customer agreed to a payment plan)"
                          aria-label="What to capture"
                        />
                        <select
                          value={dim.type}
                          onChange={e => updateDimension(i, 'type', e.target.value)}
                          className={styles.dimensionType}
                          aria-label="Type of answer"
                        >
                          {(Object.keys(DIMENSION_TYPE_LABELS) as DimensionRow['type'][]).map(t => (
                            <option key={t} value={t}>
                              {DIMENSION_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.removeBtn}
                          onClick={() => removeDimension(i)}
                          title="Remove"
                          aria-label="Remove"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      {dim.type === 'enum' && (
                        <input
                          type="text"
                          value={dim.options}
                          onChange={e => updateDimension(i, 'options', e.target.value)}
                          placeholder="Choices (comma-separated, e.g. agreed, refused, will call back)"
                          aria-label="Choices"
                        />
                      )}
                    </div>
                  ))}
                  {/* No grounding preset here, deliberately, and it is offered on
                      the call-script editor instead. A profile exists BECAUSE a
                      dialer call has no prompt template (see
                      `types/call-analysis-profile.ts`) — the agent on it is a
                      human, who does not search a catalog or a document, so
                      "did the answers match what was looked up?" has nothing to
                      judge: every such call is `not_applicable`, or the model
                      guesses and poisons the aggregate. Nor does the knowledge
                      dashboard read the dimension; it reads core's own retrieval
                      rollups (`getKnowledgeAnalytics`). */}
                  {!atDimensionLimit && (
                    <button type="button" className={styles.addBtn} onClick={addDimension}>
                      <Plus size={13} /> Add something to capture
                    </button>
                  )}
                  {atDimensionLimit && (
                    <p className={styles.helpText}>
                      That's the maximum of {MAX_ANALYSIS_DIMENSIONS} things to capture.
                    </p>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={form.is_default}
                    onChange={e => setField('is_default', e.target.checked)}
                  />
                  <span className={styles.toggleText}>
                    <span className={styles.toggleLabel}>Set as default for this account</span>
                    <span className={styles.toggleHint}>
                      Every recorded dialer call will use this unless someone picks a
                      different one when dialing.
                    </span>
                  </span>
                </label>
              </div>

              {/* Live preview — what will be captured, in plain language, before
                  anything is saved. */}
              <div className={styles.preview}>
                <p className={styles.previewTitle}>
                  <Eye size={13} aria-hidden="true" />
                  What we'll capture
                </p>
                <p className={styles.previewEmpty} style={{ marginBottom: 8 }}>
                  A short summary of the conversation, how the customer sounded, and the
                  main things that were discussed.
                </p>
                {previewDimensions.length > 0 ? (
                  <ul className={styles.previewList}>
                    {previewDimensions.map(dim => (
                      <li key={dim.key}>
                        {dim.description}{' '}
                        <span className={styles.previewAnswer}>— {describeDimension(dim)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.previewEmpty}>
                    Nothing extra yet. Add something above to capture specific details too.
                  </p>
                )}
              </div>
            </div>

            <div className={styles.modalFooter}>
              <button type="button" className="btn-secondary" onClick={handleClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                <Save size={14} />
                {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete call summary"
        message={`Delete "${deleteTarget?.name}"? Calls already summarized keep their summaries — this only stops it being used for new calls.`}
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

