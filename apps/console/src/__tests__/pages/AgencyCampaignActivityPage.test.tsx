import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type {
  ActivityActionOption,
  ActivityPage,
  ActivityRow,
} from '../../types/agency-activity';

/**
 * The campaign Activity view.
 *
 * What this file pins is the set of things that would each ship a plausible,
 * broken feature: a trail that shows only one store's rows, a short trail that
 * does not say it is short, a retention horizon hardcoded in the client, and an
 * export that silently drops the filters it was taken under.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getCampaignActivity: vi.fn(),
  downloadCampaignActivityCsv: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agencyCampaigns', () => ({ getAgencyCampaign: mocks.getAgencyCampaign }));
vi.mock('../../api/agencyActivity', () => ({
  getCampaignActivity: mocks.getCampaignActivity,
  downloadCampaignActivityCsv: mocks.downloadCampaignActivityCsv,
}));

import ActivityPageView from '../../pages/agency/AgencyCampaignActivityPage';

/** Dialer-runtime-only: no console row exists for an automatic pause. */
const AUTO_PAUSE: ActivityRow = {
  id: 'core:c-auto',
  at: '2026-08-01T11:00:00.000Z',
  source: 'core',
  action: 'agency_campaign.auto_paused',
  actor: { type: 'system', system: true, user_id: null, api_key_id: null, display: 'system:abandonment-guardrail' },
  target: { type: 'agency_campaign', id: 'camp-1' },
  detail: { reason: 'abandonment_ceiling', measured_pct: 4.2, ceiling_pct: 3 },
};

/** API-layer-only, and its `target.id` is the ATTEMPT, not the campaign. */
const DISPOSITION: ActivityRow = {
  id: 'master:m-disp',
  at: '2026-08-01T12:00:00.000Z',
  source: 'master',
  action: 'agency_disposition.created',
  actor: { type: 'human', system: false, user_id: 'user-1', api_key_id: null, display: 'Sam Patel' },
  target: { type: 'agency_disposition', id: 'attempt-9' },
  detail: { disposition_code: 'promise_to_pay', on_behalf: true },
};

/**
 * The action vocabulary the server serves alongside the rows.
 *
 * The filter is built from THIS and from nothing in the client — a
 * hand-maintained list could not be checked against the server's own catalog.
 */
const SERVED_ACTIONS: ActivityActionOption[] = [
  { value: 'agency_campaign.paused', label: 'Paused', group: 'Campaign' },
  { value: 'agency_campaign.auto_paused', label: 'Auto-paused', group: 'Campaign' },
  { value: 'agency_disposition.created', label: 'Disposition filed', group: 'Calls' },
  { value: 'dnc_entry.created', label: 'Marked do-not-call', group: 'Calls' },
  { value: 'agency_session.joined', label: 'Agent joined', group: 'Staffing' },
];

function page(over: Partial<ActivityPage> = {}): ActivityPage {
  return {
    rows: [DISPOSITION, AUTO_PAUSE],
    next_cursor: null,
    total: 2,
    partial: false,
    partial_reason: null,
    retention: { earliest_retained_at: '2026-05-01T00:00:00.000Z', source: 'partition_bound' },
    available_actions: SERVED_ACTIONS,
    ...over,
  };
}

/**
 * Scoped to a row, because the action names are also the filter checkbox
 * labels — a bare `getByText('Auto-paused')` matches the control as well as the
 * cell, and would keep passing if the table stopped rendering entirely.
 */
function row(id: string) {
  return within(screen.getByTestId(`activity-row-${id}`));
}

/**
 * Each "What happened" group is now a `MultiSelectFilter` dropdown, not a flat
 * run of chips — its checkboxes only exist in the DOM while it is open. Opens
 * it if it is not already; clicking an already-open trigger would toggle it
 * shut instead, which matters for a test that ticks two boxes from the same
 * group in a row (the second call is then a no-op, and that is correct).
 */
function openActionGroup(groupLabel: string) {
  const trigger = screen.getByRole('button', { name: groupLabel });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
}

/**
 * The export control is disabled while the first page is in flight. Waiting
 * only for `getCampaignActivity` to have been *called* is not enough — a
 * click against that disabled button is a no-op, which is how "surfaces a
 * refused export" went red in CI without the download mock ever running.
 */
async function clickExportCsv() {
  const button = await waitFor(() => {
    const el = screen.getByRole('button', { name: /export csv/i }) as HTMLButtonElement;
    if (el.disabled) throw new Error('export still disabled');
    return el;
  });
  fireEvent.click(button);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/activity']}>
      <Routes>
        <Route path="/agency/campaigns/:id/activity" element={<ActivityPageView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
  });
  // A TERMINAL campaign — the primary case, not an afterthought.
  mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Q3 collections', status: 'stopped' });
  mocks.getCampaignActivity.mockResolvedValue(page());
  mocks.downloadCampaignActivityCsv.mockResolvedValue({
    blob: new Blob(['at,source\n']),
    truncated: false,
    rowLimit: null,
  });
  // happy-dom has no object-URL plumbing for the download anchor.
  URL.createObjectURL = vi.fn(() => 'blob:activity');
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe('the merged trail', () => {
  /**
   * The assertion that distinguishes a working merge from a half one. A test
   * checking "rows rendered" would pass against a view showing only the
   * console's rows — and the dialer-only row is the one a compliance reviewer
   * came for.
   */
  it('renders rows from both stores, labelled by which recorded them', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-disp')).toBeTruthy());
    expect(row('master:m-disp').getByText('Disposition filed')).toBeTruthy();
    expect(row('core:c-auto').getByText('Auto-paused')).toBeTruthy();
    expect(row('master:m-disp').getByText('Console')).toBeTruthy();
    expect(row('core:c-auto').getByText('Dialer')).toBeTruthy();
  });

  /**
   * "Paused" without the rate it measured and the ceiling it broke tells a
   * reviewer nothing — that pair IS the content of the row.
   */
  it('spells out the measured abandonment rate on an automatic pause', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Abandonment reached 4\.2%, over the 3% ceiling/)).toBeTruthy(),
    );
  });

  /** The audit case `on_behalf` exists for is never buried in an expander. */
  it('says when a disposition was filed for the agent who took the call', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/on behalf of the agent who took the call/)).toBeTruthy(),
    );
  });

  it('shows a system actor as the mechanism, not as a blank', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-core:c-auto')).toBeTruthy());
    expect(row('core:c-auto').getByText('system:abandonment-guardrail')).toBeTruthy();
    expect(row('master:m-disp').getByText('Sam Patel')).toBeTruthy();
  });
});

describe('stating what is missing', () => {
  /**
   * The whole reason the API carries `partial`. A view that silently omits the
   * dialer's half — every status change and any automatic pause — is worse than
   * one that says it is incomplete.
   */
  it('raises a banner naming what is missing when the dialer could not be read', async () => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({ partial: true, partial_reason: 'core_unreachable', total: null, retention: null }),
    );

    renderPage();

    const banner = await screen.findByTestId('activity-partial');
    expect(banner.textContent).toMatch(/could not be reached/);
    expect(banner.textContent).toMatch(/status changes and any automatic pause/);
  });

  it('shows no banner when the trail is whole', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-disp')).toBeTruthy());
    expect(screen.queryByTestId('activity-partial')).toBeNull();
  });

  /**
   * The retention window is configured server-side — in
   * the retention Lambda, not even in the server's own config — so a number copied
   * into this client would go stale and tell the operator the wrong thing.
   */
  it('states the retention horizon from the API', async () => {
    renderPage();

    const line = await screen.findByTestId('activity-retention');
    expect(line.textContent).toMatch(/The dialer’s records go back to/);
    expect(line.textContent).toMatch(/2026/);
    // Scoped, not blanket: the horizon is derived from the dialer's partitions
    // and says nothing about how long the console keeps its own records.
    expect(line.textContent).toMatch(/Console records follow their own retention schedule/);
  });

  it('says nothing about retention when nothing has aged out', async () => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({ retention: { earliest_retained_at: null, source: 'unbounded' } }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-disp')).toBeTruthy());
    expect(screen.queryByTestId('activity-retention')).toBeNull();
  });
});

/**
 * The action filter is now built from `available_actions` on the response.
 *
 * A hand-maintained list here would be unverifiable against the server's action
 * catalog and event types. What these pin is that nothing is copied back in — not
 * as a list, and not as a fallback.
 */
describe('the action filter', () => {
  it('renders the options the server sent, grouped and labelled as it named them', async () => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({
        available_actions: [
          // A label no build of this client would have invented, so a passing
          // assertion can only mean the copy came off the response.
          { value: 'agency_campaign.auto_paused', label: 'Halted on its own', group: 'Safety' },
        ],
      }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Safety' }));
    const checkbox = await screen.findByLabelText('Halted on its own');
    expect(screen.getByText('Safety')).toBeTruthy();
    // And nothing the server did not offer: a checkbox this client invented
    // would filter on a name no store writes and return an empty trail, which
    // reads to a supervisor as "this never happened".
    expect(screen.queryByLabelText('Disposition filed')).toBeNull();

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(2));
    expect(mocks.getCampaignActivity.mock.calls[1]![1].actions).toEqual([
      'agency_campaign.auto_paused',
    ]);
  });

  /**
   * An older server that does not send the field.
   *
   * The filter goes away rather than falling back to a built-in list — that
   * fallback is the mirror this removed, and every stale entry in it would be a
   * control that silently matches nothing. The dates are untouched, because they
   * are the filter that matters on a finished campaign.
   */
  it.each([
    // The first is the older-server case literally: no such key on the body.
    ['the key is absent', () => {
      const body = page();
      delete body.available_actions;
      return body;
    }],
    ['the list is empty', () => page({ available_actions: [] })],
  ])('hides the action filter when %s, and says why without breaking the dates', async (_name, body) => {
    mocks.getCampaignActivity.mockResolvedValue(body());

    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-action-filter-unavailable')).toBeTruthy());
    expect(screen.queryByLabelText('Disposition filed')).toBeNull();
    expect(screen.queryByText('What happened')).toBeNull();

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(2));
    const [, filters] = mocks.getCampaignActivity.mock.calls[1]!;
    expect(filters.from).toBeTruthy();
    expect(filters.actions).toBeUndefined();
  });

  /**
   * The guarantee that survived the rework, and the one this view cannot trade
   * away: the served list says what is worth OFFERING as a filter, never what
   * the trail can contain. An action no build knows — a newer server's, or an
   * older server serving no vocabulary at all — must still reach the table,
   * legible as itself rather than blank or dropped.
   */
  it.each([
    ['the vocabulary does not name it', SERVED_ACTIONS],
    ['no vocabulary was served at all', undefined],
  ])('renders an unrecognised action under its raw name when %s', async (_name, available) => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({
        rows: [{ ...AUTO_PAUSE, id: 'core:c-new', action: 'agency_campaign.teleported' }],
        ...(available ? { available_actions: available } : {}),
      }),
    );

    renderPage();

    const cell = await screen.findByTestId('activity-row-core:c-new');
    expect(within(cell).getByText('agency_campaign.teleported')).toBeTruthy();
  });
});

describe('filters and export', () => {
  it('applies an action filter and an inclusive date range', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());

    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Disposition filed'));
    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2026-08-03' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(2));
    const [, filters] = mocks.getCampaignActivity.mock.calls[1]!;
    expect(filters.actions).toEqual(['agency_disposition.created']);
    // Inclusive of the chosen day: "to 3 August" means the end of the 3rd, and
    // the off-by-one silently drops a whole day of a compliance window.
    expect(new Date(filters.to).getUTCDate() >= 3).toBe(true);
    expect(filters.from).toBeTruthy();
  });

  /** The file must be the view, filters and all. */
  it('exports with the filters currently in force', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());

    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Marked do-not-call'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(2));

    await clickExportCsv();

    await waitFor(() => expect(mocks.downloadCampaignActivityCsv).toHaveBeenCalled());
    const [campaignId, filters] = mocks.downloadCampaignActivityCsv.mock.calls[0]!;
    expect(campaignId).toBe('camp-1');
    expect(filters.actions).toEqual(['dnc_entry.created']);
  });

  /** A truncated export must not be handed over as if it were the whole trail. */
  it('warns when the export stopped at the server ceiling', async () => {
    mocks.downloadCampaignActivityCsv.mockResolvedValue({
      blob: new Blob(['at\n']),
      truncated: true,
      rowLimit: 5000,
    });

    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());
    await clickExportCsv();

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    expect(mocks.showToast.mock.calls[0]![0]).toMatch(/Only the most recent 5,000 entries/);
    expect(mocks.showToast.mock.calls[0]![1]).toBe('error');
  });

  /**
   * The server's 424 is an answer — it refused to write a file missing the dialer's
   * half — so it must reach the operator rather than being swallowed.
   */
  it('surfaces a refused export instead of failing silently', async () => {
    mocks.downloadCampaignActivityCsv.mockRejectedValue(new Error('Trail Incomplete'));

    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());
    await clickExportCsv();

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
  });

  /**
   * The ceiling is read out of a response header, so "truncated, size unknown"
   * is a state the server can actually put this page in. The warning must survive
   * losing the number — and must not carry the number's absence into the copy.
   */
  it('still warns when the ceiling itself could not be read', async () => {
    mocks.downloadCampaignActivityCsv.mockResolvedValue({
      blob: new Blob(['at\n']),
      truncated: true,
      rowLimit: null,
    });

    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());
    await clickExportCsv();

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    const [message, level] = mocks.showToast.mock.calls[0]!;
    expect(message).not.toMatch(/NaN|undefined|null/);
    expect(message).toMatch(/does not contain every entry/);
    expect(message).toMatch(/Narrow the date range/);
    expect(level).toBe('error');
  });
});

/**
 * The name the file lands on disk under.
 *
 * A campaign name is free text typed by a supervisor, and `/`, `:` and `?` in a
 * `download` attribute are rejected or silently mangled by browsers — so the
 * name is sanitised through the same helper the outcome-report exports use
 * rather than interpolated raw.
 */
describe('the exported file name', () => {
  /**
   * The `download` the anchor was actually given. Restored after every case:
   * the spy replaces `document.createElement` for the whole renderer, and a
   * leaked one re-wraps itself on the next test.
   */
  let restoreCreateElement: (() => void) | null = null;
  let downloadName = '';

  function captureDownloadName() {
    const createEl = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = createEl(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          set: (v: string) => { downloadName = v; },
          get: () => downloadName,
          configurable: true,
        });
        // happy-dom would otherwise try to follow the blob: URL on click().
        el.click = () => {};
      }
      return el as HTMLElement;
    });
    restoreCreateElement = () => spy.mockRestore();
  }

  afterEach(() => {
    restoreCreateElement?.();
    restoreCreateElement = null;
    downloadName = '';
  });

  async function exportWithCampaignName(name: string | null) {
    // `null` is the header request failing — the page renders the trail anyway,
    // so the export has to name the file without it.
    if (name === null) mocks.getAgencyCampaign.mockRejectedValue(new Error('no campaign'));
    else mocks.getAgencyCampaign.mockResolvedValue({ id: 'camp-1', name, status: 'stopped' });

    captureDownloadName();
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());
    await clickExportCsv();
    await waitFor(() => expect(mocks.downloadCampaignActivityCsv).toHaveBeenCalled());
    await waitFor(() => expect(downloadName).not.toBe(''));
    return downloadName;
  }

  it('strips path and reserved characters out of the campaign name', async () => {
    const name = await exportWithCampaignName('Q3/Q4: collections?');

    // Nothing a filesystem or a browser treats as structure survives...
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    // ...while the file is still recognisably this campaign's, and is still a
    // single `.csv`.
    expect(name).toMatch(/^activity-/);
    expect(name).toMatch(/collections/);
    expect(name.endsWith('.csv')).toBe(true);
    expect(name).not.toMatch(/\.csv\.csv$/);
  });

  /**
   * A name made only of separators sanitises to nothing. The file must still
   * say which campaign it came from, so the id has to survive — the prefix on
   * its own (`activity.csv`) identifies nothing.
   */
  it('falls back to the campaign id when the name sanitises away', async () => {
    const name = await exportWithCampaignName('///');

    expect(name).toBe('activity-camp-1.csv');
  });

  it('falls back to the campaign id when the campaign header never loaded', async () => {
    const name = await exportWithCampaignName(null);

    expect(name).toBe('activity-camp-1.csv');
  });
});

describe('paging', () => {
  it('offers older entries only while the stream has more, and appends them', async () => {
    mocks.getCampaignActivity.mockResolvedValueOnce(page({ next_cursor: 'cursor-1' }));
    renderPage();

    const more = await screen.findByRole('button', { name: /load older entries/i });

    mocks.getCampaignActivity.mockResolvedValueOnce(
      page({
        rows: [{ ...DISPOSITION, id: 'master:m-old', at: '2026-07-30T09:00:00.000Z' }],
        next_cursor: null,
      }),
    );
    fireEvent.click(more);

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-old')).toBeTruthy());
    // The first page is still on screen — this is "load more", not "next page".
    expect(screen.getByTestId('activity-row-core:c-auto')).toBeTruthy();
    expect(mocks.getCampaignActivity.mock.calls[1]![2]).toMatchObject({ cursor: 'cursor-1' });
    expect(screen.queryByRole('button', { name: /load older entries/i })).toBeNull();
  });
});

describe('honesty of the page state', () => {
  /**
   * `retentionNotice(null)` is the "could not be checked" warning, so reading it
   * off an unloaded page put an alarming, false notice on screen during every
   * first paint — and left it there permanently if the request errored.
   */
  it('does not warn about retention before anything has loaded', async () => {
    let release: (value: unknown) => void = () => {};
    mocks.getCampaignActivity.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    renderPage();

    expect(screen.queryByTestId('activity-retention')).toBeNull();
    release(page());
    await waitFor(() => expect(screen.getByTestId('activity-retention')).toBeTruthy());
  });

  /**
   * `partial` is a property of the SESSION, not of the last page fetched. A
   * degraded first page followed by a whole second one must not remove the
   * banner while the incomplete rows are still on screen.
   */
  it('keeps the partial banner once any page has been degraded', async () => {
    mocks.getCampaignActivity.mockResolvedValueOnce(
      page({ partial: true, partial_reason: 'core_unreachable', total: null, retention: null, next_cursor: 'c1' }),
    );
    renderPage();

    const more = await screen.findByRole('button', { name: /load older entries/i });
    expect(screen.getByTestId('activity-partial')).toBeTruthy();

    mocks.getCampaignActivity.mockResolvedValueOnce(page({ next_cursor: null }));
    fireEvent.click(more);

    await waitFor(() => expect(screen.getAllByTestId(/activity-row-/).length).toBeGreaterThan(2));
    expect(screen.getByTestId('activity-partial')).toBeTruthy();
  });

  it('states how many entries are shown against the true total', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({ total: 213 }));

    renderPage();

    const count = await screen.findByTestId('activity-count');
    expect(count.textContent).toBe('Showing 2 of 213 entries');
  });

  /** `total` is null exactly when a half is missing — omitted, never guessed. */
  it('omits the total rather than guessing when the trail is partial', async () => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({ partial: true, partial_reason: 'core_error', total: null }),
    );

    renderPage();

    expect((await screen.findByTestId('activity-count')).textContent).toBe('Showing 2 entries');
  });

  /**
   * The dialer has no user table, so a non-system actor there is the calling
   * application. Rendered plainly it reads as the name of whoever acted, which
   * on an attribution surface is the worst possible cell.
   */
  it('never presents a dialer row\'s actor as a person', async () => {
    mocks.getCampaignActivity.mockResolvedValue(
      page({
        rows: [{
          ...AUTO_PAUSE,
          action: 'agency_campaign.paused',
          actor: { type: 'unknown', system: false, user_id: null, api_key_id: null, display: 'magick-agency-console' },
        }],
      }),
    );

    renderPage();

    const cell = await screen.findByTestId('activity-client-actor');
    expect(cell.textContent).toContain('magick-agency-console');
    expect(cell.textContent).toContain('(app)');

    // The explanation must be reachable by keyboard and announced by a
    // screen reader, not trapped in a `title` a mouse-only user hovers.
    expect(cell.getAttribute('title')).toBeNull();
    expect(cell.tabIndex).toBe(0);
    const describedById = cell.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!);
    expect(description?.textContent).toMatch(/does not record who pressed the button/);
    expect(description?.textContent).toMatch(/names the person/);
  });

  /**
   * The server refuses an inverted range too, but telling the supervisor before they
   * press Apply is the difference between a correction and a support ticket —
   * and stops it being reported as "the voice service returned an error".
   */
  it('blocks an inverted date range before it is ever sent', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-08-31' },
    });
    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2026-08-01' },
    });

    expect(screen.getByTestId('activity-inverted-range')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(1);
  });
});

describe('races', () => {
  /**
   * Two filter changes in quick succession: a slow first response landing after
   * the second would leave the earlier query's rows under the later query's
   * filters — which on an audit surface reads as rows that do not match the
   * question, not as a race.
   */
  it('ignores a slow response that a newer query has already superseded', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(1));

    let releaseStale: (value: unknown) => void = () => {};
    mocks.getCampaignActivity.mockReturnValueOnce(
      new Promise((resolve) => { releaseStale = resolve; }),
    );
    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Disposition filed'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalledTimes(2));

    mocks.getCampaignActivity.mockResolvedValueOnce(
      page({ rows: [{ ...DISPOSITION, id: 'master:fresh' }] }),
    );
    // Same group, still open from the toggle above — clicking the trigger
    // again here would close it instead of reaching the second checkbox.
    fireEvent.click(screen.getByLabelText('Marked do-not-call'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByTestId('activity-row-master:fresh')).toBeTruthy());

    // The stale response arrives last and must be discarded.
    releaseStale(page({ rows: [{ ...DISPOSITION, id: 'master:stale' }] }));
    await waitFor(() => expect(screen.getByTestId('activity-row-master:fresh')).toBeTruthy());
    expect(screen.queryByTestId('activity-row-master:stale')).toBeNull();
  });

  /** A page fetched for the OLD filter must never be appended under the new one. */
  it('drops a load-more page whose filter changed while it was in flight', async () => {
    mocks.getCampaignActivity.mockResolvedValueOnce(page({ next_cursor: 'c1' }));
    renderPage();

    const more = await screen.findByRole('button', { name: /load older entries/i });

    let releaseOlder: (value: unknown) => void = () => {};
    mocks.getCampaignActivity.mockReturnValueOnce(
      new Promise((resolve) => { releaseOlder = resolve; }),
    );
    fireEvent.click(more);

    mocks.getCampaignActivity.mockResolvedValueOnce(page({ rows: [], next_cursor: null }));
    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Disposition filed'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryAllByTestId(/activity-row-/)).toHaveLength(0));

    releaseOlder(page({ rows: [{ ...DISPOSITION, id: 'master:older' }], next_cursor: null }));
    await waitFor(() => expect(screen.queryByTestId('activity-row-master:older')).toBeNull());
  });
});

describe('permissions', () => {
  /**
   * The floor the server enforces is `audit.read` (`account_admin`).
   * A `viewer` who could see the button would only get a 403 on click.
   */
  it('hides the export from a role below the floor the server enforces', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
    });

    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-disp')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull();
  });
});

describe('accessibility', () => {
  /**
   * A table with no name is unannounceable — a screen-reader user landing on
   * it hears "table, 2 rows" with no way to tell it apart from any other
   * table on the page, let alone which campaign it belongs to.
   */
  it('gives the table an accessible name naming the campaign it belongs to', async () => {
    renderPage();

    const table = await screen.findByRole('table', { name: /Q3 collections/ });
    // Visually hidden, not absent: sighted users already have the "Activity"
    // heading and the campaign badge, so the caption must not duplicate that
    // on screen while still being the table's accessible name.
    expect(table.querySelector('caption')?.className).toMatch(/srOnly/);
  });

  /**
   * The count line is the only signal that applying a filter, or "Load older
   * entries" appending rows, changed anything on screen — neither moves focus
   * or scrolls. Without `aria-live` a screen-reader user gets silence.
   */
  it('announces the entry count as a single polite live region', async () => {
    renderPage();

    const count = await screen.findByTestId('activity-count');
    expect(count.getAttribute('aria-live')).toBe('polite');
    // Exactly one live region for this fact — a second would race the first
    // and a screen reader would garble whichever loses. `findByTestId` above
    // resolves the instant the (unconditionally-mounted) node exists, which
    // can be before the rows land and its text is filled in — wait for the
    // text rather than assuming it's already there, same as the other
    // assertions on this node elsewhere in this file.
    await waitFor(() => expect(screen.getAllByText(/^Showing /).length).toBe(1));
  });

  it('updates the live count when a filter narrows the trail', async () => {
    renderPage();
    // The count region unmounts during the reload (it lives inside the
    // `!loading` block), so a reference taken before the reload goes stale —
    // re-querying, not the held node, is what a screen reader effectively
    // does too: it reports whatever is in the live region when it settles.
    expect((await screen.findByTestId('activity-count')).textContent).toBe(
      'Showing 2 of 2 entries',
    );

    mocks.getCampaignActivity.mockResolvedValueOnce(
      page({ rows: [DISPOSITION], total: 1 }),
    );
    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Disposition filed'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(screen.getByTestId('activity-count').textContent).toBe('Showing 1 of 1 entries'),
    );
    expect(screen.getByTestId('activity-count').getAttribute('aria-live')).toBe('polite');
  });

  /**
   * The property that makes the live region work at all, and the one an
   * attribute assertion cannot reach.
   *
   * A screen reader only announces an `aria-live` region that was ALREADY in the
   * accessibility tree when its contents changed; one inserted already-populated
   * is announced by some AT and silently dropped by most. Rendered inside the
   * rows block, the region unmounted behind the spinner on every reload and came
   * back full — so the single signal that applying a filter changed anything was
   * the signal least likely to arrive.
   *
   * This asserts the same DOM NODE survives a filter change, which is what
   * "already in the tree" means in practice.
   */
  it('keeps one live region mounted across a reload, rather than remounting it full', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('activity-count').textContent).toContain('Showing'),
    );
    const node = screen.getByTestId('activity-count');

    let release: (value: unknown) => void = () => {};
    mocks.getCampaignActivity.mockReturnValueOnce(
      new Promise((resolve) => { release = resolve; }),
    );
    openActionGroup('Calls');
    fireEvent.click(screen.getByLabelText('Disposition filed'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // Mid-reload: still the same element, emptied rather than removed.
    await waitFor(() => expect(screen.getByTestId('activity-count').textContent).toBe(''));
    expect(screen.getByTestId('activity-count')).toBe(node);

    release(page({ rows: [DISPOSITION], total: 1 }));
    await waitFor(() =>
      expect(screen.getByTestId('activity-count').textContent).toBe('Showing 1 of 1 entries'),
    );
    // And the announcement happened to the node that was already there.
    expect(screen.getByTestId('activity-count')).toBe(node);
  });

  /**
   * WCAG 2.5.3 Label in Name: a voice-control user says what they see. An
   * `aria-label` that diverges from the visible "From"/"To" text used to send
   * "From" nowhere, because the accessible name had silently become "Show
   * activity from this date".
   */
  it('gives the date filters accessible names that contain their visible labels', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getCampaignActivity).toHaveBeenCalled());

    const from = screen.getByLabelText('From date') as HTMLInputElement;
    const to = screen.getByLabelText('To date') as HTMLInputElement;
    expect(from.type).toBe('date');
    expect(to.type).toBe('date');
    expect(from.getAttribute('aria-label')).toBeNull();
    expect(to.getAttribute('aria-label')).toBeNull();
  });

  /**
   * The Console-vs-Dialer explanation used to live only in a per-row `title`,
   * invisible to keyboard and screen-reader users. It must now be plain text
   * in the document, not conditional on hover.
   */
  it('states the Console/Dialer distinction as a persistent, visible legend', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByTestId('activity-row-master:m-disp')).toBeTruthy());
    expect(
      screen.getByText(/Console is someone in this workspace pressing a control/),
    ).toBeTruthy();

    const tag = screen.getByTestId('activity-source-master');
    expect(tag.getAttribute('title')).toBeNull();
    // The tag's accessible name is plain and matches what is on screen —
    // no hidden surprise, because the explanation lives in the legend.
    expect(tag.getAttribute('aria-label')).toBe(tag.textContent);
  });
});

/**
 * ── This screen is a section of the campaign workspace  ──────────
 *
 * The bar is what makes it one, and it is rendered by each page rather than by
 * a shared route layout — so without an assertion here it could be deleted
 * from this one file and every suite in the repo would stay green. That is the
 * whole reason this test exists.
 */
describe('the campaign section bar', () => {
  it('renders the bar and marks Activity as the current section', async () => {
    renderPage();

    const tab = await screen.findByTestId('campaign-tab-activity');
    expect(tab.getAttribute('aria-current')).toBe('page');
    // Its neighbours are reachable from here — the point of the bar is that
    // getting to another section does not mean going back through the campaign.
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
  });
});

/**
 * **A credential is not a person and not the system.**
 *
 * The server stopped stamping a key's CREATOR as the actor, so a key-authenticated
 * row now arrives with `user_id: null` — the same shape a scheduler write has.
 * The pre-existing cell keyed its "Automatic" branch on `actor.system`, which
 * the server keeps false for a key precisely so that branch cannot swallow one; this
 * pins that it does not, and that the row names the credential instead.
 */
describe('AgencyCampaignActivityPage — a key-authenticated row', () => {
  const KEY_ROW: ActivityRow = {
    id: 'master:m-key',
    at: '2026-08-01T13:00:00.000Z',
    source: 'master',
    action: 'agency_campaign.stopped',
    actor: {
      type: 'api_key',
      system: false,
      user_id: null,
      api_key_id: 'bbbbbbbb-0000-4000-8000-000000000001',
      display: 'Nightly sync',
    },
    target: { type: 'agency_campaign', id: 'camp-1' },
    detail: {},
  };

  it('names the credential, and never reads as Automatic', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({ rows: [KEY_ROW] }));
    renderPage();

    const cell = await screen.findByTestId('activity-key-actor');
    expect(cell.textContent).toContain('Nightly sync');
    expect(cell.textContent).toContain('API key');
    // The regression: `system` is false for a key, so the automatic branch must
    // not claim it.
    expect(screen.queryByText('Automatic')).toBeNull();
    // Nor the dialer's client-actor branch — this is a console row.
    expect(screen.queryByTestId('activity-client-actor')).toBeNull();
  });

  /**
   * The marker is appended to a NAME, never wrapped around the fallback.
   * `{display ?? 'API key'} (API key)` rendered "API key (API key)" on every row
   * the server could not name — which is the common case, since a revoked key is
   * both the one a reviewer looks up and the one most likely to go unnamed.
   */
  it('falls back to a bare label, not a doubled one, when the server cannot name it', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({
      rows: [{ ...KEY_ROW, actor: { ...KEY_ROW.actor, display: null } }],
    }));
    renderPage();

    const cell = await screen.findByTestId('activity-key-actor');
    expect(cell.textContent).toContain('API key');
    expect(cell.textContent).not.toContain('API key (API key)');
  });

  it('appends the marker to a resolved key name', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({
      rows: [{ ...KEY_ROW, actor: { ...KEY_ROW.actor, display: 'Nightly sync' } }],
    }));
    renderPage();

    const cell = await screen.findByTestId('activity-key-actor');
    expect(cell.textContent).toContain('Nightly sync (API key)');
  });

  /**
   * ── The id must be reachable without a mouse ──────────────────────────────
   * It was a `title` on the label: hover-only, so keyboard and touch users could
   * not retrieve the one value the row exists to give them — the handle the key
   * is looked up and revoked by. This file already rejects that pattern for the
   * client actor a few rows down, which is what made it inconsistent as well as
   * inaccessible. It is now a real control carrying the full id in its
   * accessible name.
   */
  it('exposes the credential id as a focusable control, not a hover tooltip', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({ rows: [KEY_ROW] }));
    renderPage();

    await screen.findByTestId('activity-key-actor');
    const control = screen.getByRole('button', { name: /API key ID bbbbbbbb-0000-4000-8000-000000000001/ });

    expect(control).toBeTruthy();
    expect(control.tagName).toBe('BUTTON');
  });

  /**
   * ── The trap the server's own contract calls out ──────────────────────────────
   *
   * A row written before the server recorded the distinction reports
   * `type: 'unknown'` while keeping `system: true`. Reading `type` here instead
   * of `system` would flip every historical background row in every campaign
   * trail from "Automatic" to an unhandled value — a visible rewrite of
   * history, from a change whose whole promise was that history renders
   * unchanged.
   */
  it('still renders an automatic row with no recorded actor type as Automatic', async () => {
    mocks.getCampaignActivity.mockResolvedValue(page({
      rows: [{
        ...AUTO_PAUSE,
        actor: { ...AUTO_PAUSE.actor, type: 'unknown' },
      }],
    }));
    renderPage();

    expect(await screen.findByText('system:abandonment-guardrail')).not.toBeNull();
  });
});
