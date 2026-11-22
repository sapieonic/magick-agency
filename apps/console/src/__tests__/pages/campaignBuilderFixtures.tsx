import { vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { AgencyColumnAnalysis, AgencyIngestJob } from '../../types/agency-campaign';
import type { StaffingAgent, StaffingApplyResult, UseCampaignStaffing } from '../../hooks/useCampaignStaffing';

/**
 * What the New campaign page tests share: the column analysis, a complete ingest job, the
 * account's agents, the staffing hook's stand-in, and the page rendered inside a router with the
 * Campaigns list and a campaign page to land on. Each test file declares its own `vi.mock`s
 * (they are hoisted per file).
 */

/** Sure of its phone column (CS8): the file is checked as soon as it is read. */
export const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Cust Mobile', 'Full Name', 'TZ', 'Internal Score'],
  columns: [
    { name: 'Cust Mobile', index: 0, samples: ['9820041772'], non_empty: 100, phone_score: 0.95, distinct: 100, distinct_phones: 100 },
    { name: 'Full Name', index: 1, samples: ['Priya Menon'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 100 },
    { name: 'TZ', index: 2, samples: ['Asia/Kolkata'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 100 },
    { name: 'Internal Score', index: 3, samples: ['0.82'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 100 },
  ],
  rows_sampled: 100,
  truncated: true,
  suggested_phone_column: 'Cust Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

/** Not sure which column is the phone (CS8): the column mapper asks, and nothing is checked by itself. */
export const UNSURE_ANALYSIS: AgencyColumnAnalysis = {
  ...ANALYSIS,
  columns: ANALYSIS.columns.map((c) => (c.name === 'Cust Mobile' ? { ...c, phone_score: 0.5 } : c)),
};

export function job(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return {
    job_id: 'job-1',
    campaign_id: 'camp-1',
    status: 'completed',
    dry_run: false,
    file_name: 'collections_aug.csv',
    dedupe_columns: [],
    progress_pct: 100,
    rows_read: 12_481,
    accepted: 11_712,
    rejected: 769,
    duplicates: 192,
    rejected_by_reason: {
      invalid_phone: 412,
      duplicate_phone: 192,
      missing_phone_value: 124,
      dnc_suppressed: 41,
    },
    core_rejected_duplicate_rows: 0,
    core_duplicate_source_rows: [],
    chunks_sent: 24,
    headers: ANALYSIS.headers,
    context_columns: ['Full Name', 'TZ'],
    has_rejected_export: true,
    rejected_row_count: 769,
    rejected_truncated: false,
    skipped: 0,
    dnc_by_scope: {},
    rejected_sample: [],
    has_skipped_export: false,
    skipped_row_count: 0,
    skipped_truncated: false,
    check_job_id: null,
    import_job_id: null,
    check_expires_at: null,
    error_code: null,
    error_message: null,
    created_by: '11111111-2222-4333-8444-555555555555',
    created_at: '2026-08-11T10:00:00.000Z',
    started_at: '2026-08-11T10:00:01.000Z',
    finished_at: '2026-08-11T10:04:00.000Z',
    ...over,
  };
}

/** A finished check of three rows, valid for an hour: what "Add 3 customers" imports. */
export function check(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return job({
    job_id: 'check-1',
    dry_run: true,
    campaign_id: null,
    rows_read: 3,
    accepted: 3,
    rejected: 0,
    duplicates: 0,
    rejected_by_reason: {},
    has_rejected_export: false,
    rejected_row_count: 0,
    check_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  });
}

/** The import of that check. */
export function imported(over: Partial<AgencyIngestJob> = {}): AgencyIngestJob {
  return job({
    job_id: 'import-1',
    dry_run: false,
    rows_read: 3,
    accepted: 3,
    rejected: 0,
    duplicates: 0,
    rejected_by_reason: {},
    has_rejected_export: false,
    rejected_row_count: 0,
    check_job_id: 'check-1',
    ...over,
  });
}

function agent(id: string, name: string): StaffingAgent {
  return {
    id,
    name,
    email: null,
    persona: 'Agent',
    avatar: { display_name: name, email: null, avatar_url: null },
    notSignedIn: false,
    inTeam: true,
  };
}

export const AGENTS: StaffingAgent[] = [agent('u-asha', 'Asha Rao'), agent('u-ravi', 'Ravi Kumar')];

export function applied(over: Partial<StaffingApplyResult> = {}): StaffingApplyResult {
  return { added: [], removed: [], failures: [], readError: null, ...over };
}

/** `useCampaignStaffing`'s return, with `applyStaffing` the test's own mock. */
export function staffingHook(applyStaffing: UseCampaignStaffing['applyStaffing']): UseCampaignStaffing {
  return {
    agents: AGENTS,
    assignedIds: [],
    loading: false,
    error: null,
    reload: vi.fn(async () => {}),
    applyStaffing,
    invitePath: null,
  };
}

/** Stands in for the sidebar or search: a push navigation from outside the page. */
function JumpAway() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/agency/campaigns')}>Jump</button>;
}

function CampaignPage() {
  const { id } = useParams();
  return <p>Campaign page {id}</p>;
}

/** New campaign at its route, with the Campaigns list and a campaign's page to land on. */
export async function renderPage() {
  const { default: CampaignBuilderPage } = await import('../../pages/campaigns/agency/CampaignBuilderPage');
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/new']}>
      <Routes>
        <Route path="/agency/campaigns/new" element={<CampaignBuilderPage />} />
        <Route path="/agency/campaigns/:id" element={<CampaignPage />} />
        <Route path="*" element={<p>Campaigns list</p>} />
      </Routes>
      <JumpAway />
    </MemoryRouter>,
  );
}

export function fillBasics(name = 'Collections') {
  fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: name } });
  fireEvent.click(screen.getByRole('checkbox', { name: '+91 22000 00001' }));
}

/** The step cards (CS1). */
export const stepCards = () => within(screen.getByRole('navigation', { name: 'Campaign setup' }));

/** A step card, by its title (a card that needs fixing is named "<title>, needs fixing"). */
export function stepCard(title: string): HTMLButtonElement {
  return stepCards().getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`) }) as HTMLButtonElement;
}

export function goToStep(title: string) {
  fireEvent.click(stepCard(title));
}

export const currentStep = () => screen.getByTestId('builder-step').getAttribute('data-step');

export const footer = () => within(screen.getByTestId('builder-footer'));

export const footerButton = (name: string | RegExp) => footer().getByRole('button', { name }) as HTMLButtonElement;

export const saveDraftButton = () => footerButton('Save as draft');

/** Drop a CSV on the Customers step. */
export function dropCsv(name = 'collections_aug.csv') {
  const input = screen.getByLabelText('CSV file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['Cust Mobile\n9820041772\n'], name, { type: 'text/csv' })] } });
}

/** Open an Advanced fold by its summary, as a supervisor does, if it is not open already. */
export function openFold(testId: string): HTMLElement {
  const fold = screen.getByTestId(testId) as HTMLDetailsElement;
  if (!fold.open) fireEvent.click(fold.querySelector('summary')!);
  return fold;
}
