import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarCheck, ClipboardList, IndianRupee, Megaphone, SquarePlus } from 'lucide-react';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import {
  AdvancedFold,
  ChoiceCardGroup,
  SetupCard,
  SetupColumns,
  SetupSection,
  StatusChip,
  type ChoiceCardOption,
} from '../../../../components/campaign-setup';
import type { AgencyDispositionEntry } from '../../../../types/agency-campaign';
import {
  editCatalog,
  followCatalogEdit,
  validateConfig,
  type CampaignConfigState,
  type CatalogEdit,
  type MappedRows,
} from '../../../../utils/agencyCampaignConfigForm';
import { MAX_TILES_WITHOUT_MORE } from '../../../../utils/agency/stationTiles';
import {
  PURPOSE_PRESETS,
  isPurposePresetId,
  presetOf,
  purposePreset,
  withPreset,
  type PurposePresetId,
} from '../../../../utils/campaignSetup/purposePresets';
import { useConfigFieldErrors } from '../configFieldErrors';
import { DispositionCatalogEditor } from '../DispositionCatalogEditor';
import { OutcomeDispositionMap } from '../OutcomeDispositionMap';
import { AgentButtonsPreview } from './AgentButtonsPreview';
import { OutcomeButtonList } from './OutcomeButtonList';
import styles from './PurposeButtonsStep.module.css';

export interface PurposeButtonsStepProps {
  config: CampaignConfigState;
  onChange: (next: CampaignConfigState) => void;
  /** The server's `details`, keyed by body path. `validateConfig`'s findings are added live; the server's win. */
  fieldErrors: Record<string, string>;
  /** `edit` is campaign Settings. */
  mode: 'create' | 'edit';
  /** A starting point replaced the buttons: the page resets what it measures from (the save's `reordered`). */
  onPresetApplied?: (presetId: string) => void;
  /** Hold Advanced open (the page sends a `#outcomes` link, or a save was refused inside it). */
  forceAdvancedOpen?: boolean;
  /**
   * Contact assignment (`agency_contact_assignment_enabled`): the full editor under Advanced offers
   * each button's "Allows override". Off, as `CampaignBehaviourSection` without `assignment`.
   */
  overrides?: boolean;
}

/** Above this many buttons the count chip turns to a warning: the station's tiles go small. */
export const BUTTONS_KEPT_TO = 6;

export const ADVANCED_SUMMARY = 'Advanced settings (most campaigns don’t need these)';

const PRESET_ICONS: Record<PurposePresetId, ReactNode> = {
  payment: <IndianRupee size={20} />,
  sales: <Megaphone size={20} />,
  survey: <ClipboardList size={20} />,
  appointment: <CalendarCheck size={20} />,
  blank: <SquarePlus size={20} />,
};

const PRESET_OPTIONS: ChoiceCardOption<PurposePresetId>[] = PURPOSE_PRESETS.map((preset) => ({
  value: preset.id,
  title: preset.title,
  description: preset.description,
  icon: <span className={styles.presetIcon}>{PRESET_ICONS[preset.id]}</span>,
}));

/** Only this step's findings: the buttons and the automatic outcomes. */
function isStepField(field: string): boolean {
  return field.startsWith('disposition_catalog') || field.startsWith('outcome_dispositions');
}

const ROW_FIELD = /^disposition_catalog\[(\d+)\]/;

/**
 * Step 3, Purpose & buttons, "What agents can pick" (CS2–CS4, CS13). Controlled: `config` in,
 * `onChange` out; New campaign and campaign Settings each own the state and the save.
 *
 *  - **A starting point** (CS2) fills the buttons (`purposePresets`). Replacing buttons that are
 *    no preset any more asks first.
 *  - **The buttons** (CS3), one row each with its rule as a sentence (`outcomeRule`). Adding,
 *    removing and moving go through `editCatalog`, as in the full editor.
 *  - **What the agent will see** (CS4), drawn by the station's own tiles.
 *  - **Advanced** (CS13): the full outcome editor and the automatic outcomes for unanswered calls,
 *    on the same config, so every field stays reachable. Open while a finding lives in it.
 *
 * ── One edit state for two editors ───────────────────────────────────────────
 * Which rows still take their code from their label (`autoCodeRows`) and which row each automatic
 * outcome follows (`followCatalogEdit`) are positions. The step holds both for the rows and runs
 * every edit of the full editor through them too. The full editor keeps its own copy of the first,
 * so it is remounted whenever the rows move under it (an add, a removal, a move or a preset here):
 * a fresh editor follows no label, which can only ever leave a code alone.
 */
export function PurposeButtonsStep({
  config,
  onChange,
  fieldErrors,
  mode,
  onPresetApplied,
  forceAdvancedOpen = false,
  overrides = false,
}: PurposeButtonsStepProps) {
  const autoCodeRows = useRef<ReadonlySet<number>>(new Set());
  const mappedRows = useRef<MappedRows>({});
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [focusNameOf, setFocusNameOf] = useState<number | null>(null);
  const [pendingPreset, setPendingPreset] = useState<PurposePresetId | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const foldRef = useRef<HTMLDivElement>(null);
  const focusFoldRow = useRef<number | null>(null);

  const dispositions = config.dispositions;
  const currentPreset = useMemo(() => presetOf(dispositions), [dispositions]);

  // ── Findings ────────────────────────────────────────────────────────────────
  const live = useMemo(() => {
    const all = validateConfig(config);
    return Object.fromEntries(Object.entries(all).filter(([field]) => isStepField(field)));
  }, [config]);
  const merged = useMemo(() => ({ ...live, ...fieldErrors }), [live, fieldErrors]);
  const quiet = useMemo(
    () => new Set(Object.keys(live).filter((field) => !(field in fieldErrors))),
    [live, fieldErrors],
  );

  /*
    A row still following its label has no code field of its own to fix: its code finding is the
    name's, said in the name's words (no code is ever shown here), and it does not open Advanced.
  */
  const following = autoCodeRows.current;
  const listMessages = useMemo(() => {
    const out: Record<string, string> = { ...merged };
    for (const row of following) {
      const field = `disposition_catalog[${row}].code`;
      if (!(field in out)) continue;
      const entry = dispositions[row];
      if (!entry || entry.label.trim() === '') delete out[field];
      else out[`disposition_catalog[${row}].label`] ??= nameFinding(dispositions, row);
    }
    return out;
  }, [merged, following, dispositions]);
  const listErrors = useConfigFieldErrors(listMessages, quiet);
  const foldErrors = useConfigFieldErrors(merged, quiet);

  const findingRows = useMemo(() => {
    const rows = new Set<number>();
    for (const field of Object.keys(listMessages)) {
      const m = ROW_FIELD.exec(field);
      if (m) rows.add(Number(m[1]));
    }
    return rows;
  }, [listMessages]);

  const foldFinding = useMemo(
    () => Object.keys(merged).some((field) => isFoldField(field, following)),
    [merged, following],
  );

  // Open when one needs fixing, and stay open once it is fixed (a fold that shuts under the
  // supervisor's pointer as they type the fix is worse than one left open).
  useEffect(() => {
    if (foldFinding || forceAdvancedOpen) setAdvancedOpen(true);
  }, [foldFinding, forceAdvancedOpen]);
  const foldOpen = advancedOpen || foldFinding || forceAdvancedOpen;

  // "More options" on a row: the fold opens, and the row's card in the full editor takes focus.
  useEffect(() => {
    const row = focusFoldRow.current;
    if (row === null || !foldOpen) return;
    focusFoldRow.current = null;
    const input = foldRef.current?.querySelector<HTMLInputElement>(`input[aria-label="Outcome ${row + 1} label"]`);
    input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    input?.focus({ preventScroll: true });
  });

  // ── Edits ───────────────────────────────────────────────────────────────────
  function apply(next: AgencyDispositionEntry[], edit: CatalogEdit) {
    const followed = followCatalogEdit(dispositions, edit, next, {
      mapping: config.outcomeDispositions,
      rows: mappedRows.current,
    });
    mappedRows.current = followed.rows;
    onChange({ ...config, dispositions: next, outcomeDispositions: followed.mapping });
  }

  /** An edit from the rows. */
  function edit(action: CatalogEdit) {
    const next = editCatalog({ dispositions, autoCodeRows: autoCodeRows.current }, action);
    autoCodeRows.current = next.autoCodeRows;
    if (next.dispositions === dispositions) return;
    apply(next.dispositions, action);
    if (action.type === 'add' || action.type === 'remove' || action.type === 'move') {
      setEditorEpoch((n) => n + 1);
      setExpanded((open) => rowAfter(open, action, dispositions.length));
      setFocusNameOf(action.type === 'add' ? dispositions.length : null);
    }
  }

  /** An edit from the full editor under Advanced: its rows are ours too. */
  function editFromFold(next: AgencyDispositionEntry[], action: CatalogEdit) {
    autoCodeRows.current = editCatalog({ dispositions, autoCodeRows: autoCodeRows.current }, action).autoCodeRows;
    // A row open above follows its own row; one added below is not opened above.
    if (action.type === 'remove' || action.type === 'move') {
      setExpanded((open) => rowAfter(open, action, dispositions.length));
      setFocusNameOf(null);
    }
    apply(next, action);
  }

  function applyPreset(id: PurposePresetId) {
    onChange(withPreset(config, id));
    autoCodeRows.current = new Set();
    mappedRows.current = {};
    setEditorEpoch((n) => n + 1);
    setExpanded(null);
    setFocusNameOf(null);
    onPresetApplied?.(id);
  }

  function pickPreset(id: PurposePresetId) {
    if (id === currentPreset) return;
    // Buttons that are still a starting point (or none at all) have nothing of the supervisor's to lose.
    if (currentPreset === null && dispositions.length > 0) setPendingPreset(id);
    else applyPreset(id);
  }

  const count = dispositions.length;
  const over = count > BUTTONS_KEPT_TO;

  return (
    <SetupCard
      title="What is this campaign for?"
      helper="Pick a starting point. It fills in the buttons and rules below, and you can change any of them."
      testId="purpose-buttons-step"
    >
      <div className={styles.step}>
        <ChoiceCardGroup
          legend="Starting point"
          hideLegend
          name="purpose-preset"
          columns={5}
          value={currentPreset}
          onChange={(v) => {
            if (isPurposePresetId(v)) pickPreset(v);
          }}
          options={PRESET_OPTIONS}
          testId="purpose-presets"
        />

        <SetupColumns split="main-aside">
          <SetupSection
            title="Buttons agents will see after each call"
            helper="Keep to 6 or fewer so agents can decide quickly. The order is the number key."
            actions={
              <StatusChip tone={over ? 'warning' : 'muted'} icon={over ? undefined : null} testId="button-count">
                {count} of {BUTTONS_KEPT_TO}
              </StatusChip>
            }
          >
            {over ? (
              <p className={styles.countNote} data-testid="button-count-note">
                {count > MAX_TILES_WITHOUT_MORE
                  ? 'With this many, agents see smaller buttons: the first 8, and the rest behind More.'
                  : 'With this many, agents see smaller buttons.'}
              </p>
            ) : null}
            <OutcomeButtonList
              dispositions={dispositions}
              onEdit={edit}
              errors={listErrors}
              findingRows={findingRows}
              expanded={expanded}
              onExpand={(index) => {
                setExpanded(index);
                setFocusNameOf(null);
              }}
              focusNameOf={focusNameOf}
              onMoreOptions={(index) => {
                focusFoldRow.current = index;
                setAdvancedOpen(true);
              }}
            />
          </SetupSection>
          <AgentButtonsPreview dispositions={dispositions} />
        </SetupColumns>

        <div ref={foldRef}>
          <AdvancedFold
            summary={ADVANCED_SUMMARY}
            open={foldOpen}
            onToggle={(open) => {
              // Held open while something in it needs fixing.
              if (!open && (foldFinding || forceAdvancedOpen)) return;
              setAdvancedOpen(open);
            }}
            testId="purpose-advanced"
          >
            <SetupSection title="All button details" headingLevel={4}>
              <DispositionCatalogEditor
                key={editorEpoch}
                dispositions={dispositions}
                onChange={editFromFold}
                errors={foldErrors}
                overrides={overrides}
                promises
                icons
              />
            </SetupSection>
            <SetupSection title="When a call is not answered" headingLevel={4}>
              <OutcomeDispositionMap
                mapping={config.outcomeDispositions}
                dispositions={dispositions}
                onChange={(outcomeDispositions) => onChange({ ...config, outcomeDispositions })}
                fieldErrors={fieldErrors}
              />
            </SetupSection>
          </AdvancedFold>
        </div>
      </div>

      <ConfirmDialog
        open={pendingPreset !== null}
        title="Replace the buttons?"
        message={
          pendingPreset === null
            ? ''
            : `The ${purposePreset(pendingPreset).title} buttons will replace the ${count} button${count === 1 ? '' : 's'} you have now, with any changes you made to them.${
              mode === 'edit' ? ' Calls already saved keep what was picked. Nothing changes until you save.' : ''
            }`
        }
        confirmLabel="Replace buttons"
        onConfirm={() => {
          const id = pendingPreset;
          setPendingPreset(null);
          if (id) applyPreset(id);
        }}
        onCancel={() => setPendingPreset(null)}
      />
    </SetupCard>
  );
}

/**
 * Findings that live in the fold: a code the supervisor typed, an override, a promise follow-up,
 * the automatic outcomes, the list as a whole. A row's other findings are fixed in its sentence.
 */
function isFoldField(field: string, following: ReadonlySet<number>): boolean {
  if (field === 'disposition_catalog' || field.startsWith('outcome_dispositions')) return true;
  const m = /^disposition_catalog\[(\d+)\]\.(code|override(\..+)?|promise_follow_up_days)$/.exec(field);
  if (!m) return false;
  return !(m[2] === 'code' && following.has(Number(m[1])));
}

/** What is wrong with a following row's name, when its code (made from the name) is refused. */
function nameFinding(dispositions: readonly AgencyDispositionEntry[], row: number): string {
  const code = dispositions[row]?.code ?? '';
  if (code === '') return 'Use some letters or numbers in the name.';
  if (dispositions.some((entry, i) => i < row && entry.code === code)) {
    return 'Another button already has this name. Give this one a different name.';
  }
  return 'This name is kept for the system’s own use. Give the button another name.';
}

/** Where the open row is after `edit`, or `null` when it went away. A new row opens. */
function rowAfter(open: number | null, edit: CatalogEdit, length: number): number | null {
  if (edit.type === 'add') return length;
  if (open === null) return null;
  if (edit.type === 'remove') {
    if (open === edit.index) return null;
    return open > edit.index ? open - 1 : open;
  }
  if (edit.type === 'move') {
    const target = edit.index + edit.delta;
    if (open === edit.index) return target;
    if (open === target) return edit.index;
  }
  return open;
}
