import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgencyCallExportFieldsResponse } from '@magick-agency/contracts/api/agency/call-export-fields';

/**
 * Export with fields' dialog (`docs/call-log.md` §10, CL43–CL52), on its own: the groups drawn
 * from the field list, Select all / Clear, the column preview and the order `fields` is sent
 * in, the ceiling note, the remembered choice, and the refusals. How the Call log opens it and
 * what reaches the server is `AgencyCampaignAttemptsPage.test.tsx`'s.
 */

const mocks = vi.hoisted(() => ({ getCallExportFields: vi.fn() }));
vi.mock('../../api/agencySpine', () => ({ getCallExportFields: mocks.getCallExportFields }));

import { ExportFieldsDialog } from '../../components/agency/callLog/ExportFieldsDialog';
import { ApiError } from '../../api/client';
import { exportFieldsFixture } from '../helpers/callExportFields';
import { callExportFieldsKey } from '../../utils/agency/callExportFieldsStore';

const KEY = callExportFieldsKey('u-1', 't-1', 'a-1', 'camp-1');
const QUERY = { outcome: ['connected'], source: 'dialler' };

function renderDialog(overrides: { onDownload?: (fields: string[]) => Promise<void>; onClose?: () => void; storageKey?: string | null } = {}) {
  const onDownload = vi.fn(overrides.onDownload ?? (async () => {}));
  const onClose = vi.fn(overrides.onClose ?? (() => {}));
  render(
    <ExportFieldsDialog
      open
      onClose={onClose}
      campaignId="camp-1"
      query={QUERY}
      dates="20 Nov to 27 Nov"
      type="Dialler"
      storageKey={overrides.storageKey === undefined ? KEY : overrides.storageKey}
      tenantId="t-1"
      accountId="a-1"
      onDownload={onDownload}
    />,
  );
  return { onDownload, onClose };
}

async function ready(response: AgencyCallExportFieldsResponse = exportFieldsFixture()) {
  mocks.getCallExportFields.mockResolvedValue(response);
  const handles = renderDialog();
  await screen.findByText('Columns in the file');
  return handles;
}

function box(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!;
}

function previewChosen(): string[] {
  return screen.queryAllByTestId('export-fields-preview-chosen').map((el) => el.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('opening', () => {
  it('reads the field list for the export’s own query, and says the view in the subtitle', async () => {
    await ready();
    expect(mocks.getCallExportFields).toHaveBeenCalledWith('camp-1', QUERY, 't-1', 'a-1');
    expect(screen.getByText('24,812 calls · 20 Nov to 27 Nov · Dialler')).toBeTruthy();
    expect(screen.getByText('The file keeps its usual columns; what you tick here is added at the end.')).toBeTruthy();
  });

  it('shows a loading state, then the groups', async () => {
    let resolve!: (value: AgencyCallExportFieldsResponse) => void;
    mocks.getCallExportFields.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderDialog();
    expect(screen.getByTestId('export-fields-loading')).toBeTruthy();
    expect((screen.getByTestId('export-fields-download') as HTMLButtonElement).disabled).toBe(true);
    // Before the count is known the subtitle says the dates and type alone.
    expect(screen.getByText('20 Nov to 27 Nov · Dialler')).toBeTruthy();
    await act(async () => resolve(exportFieldsFixture()));
    expect(screen.queryByTestId('export-fields-loading')).toBeNull();
    // Loaded with nothing ticked: Download waits for a field.
    expect((screen.getByTestId('export-fields-download') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box('ai_summary'));
    expect((screen.getByTestId('export-fields-download') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a failed read and reads again on Retry', async () => {
    mocks.getCallExportFields.mockRejectedValueOnce(new Error('Network down'));
    renderDialog();
    const error = await screen.findByTestId('export-fields-error');
    expect(error.textContent).toContain('Network down');
    expect((screen.getByTestId('export-fields-download') as HTMLButtonElement).disabled).toBe(true);
    mocks.getCallExportFields.mockResolvedValueOnce(exportFieldsFixture());
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }));
    await screen.findByText('Columns in the file');
    expect(mocks.getCallExportFields).toHaveBeenCalledTimes(2);
  });

  it('says when the calls have nothing to add', async () => {
    await ready(exportFieldsFixture({ analysis: [], dimensions: [], call_fields: [] }));
    expect(screen.getByTestId('export-fields-empty')).toBeTruthy();
    expect(screen.getByTestId('export-fields-always')).toBeTruthy();
  });
});

describe('the groups', () => {
  it('come in order, each option with its name, its second line and its count', async () => {
    await ready();
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      'Always in the file', 'Call details the agent entered', 'Call analysis', 'Custom dimensions', 'Columns in the file',
    ]);
    expect(screen.getByTestId('export-fields-always').textContent).toMatch(/promise to pay/);
    expect(screen.getByText('Soft-phone calls only')).toBeTruthy();
    expect(screen.getByText('18,003 of 24,812 calls analysed')).toBeTruthy();

    // A call field the soft phone removed: its key as words, and why it has no type.
    expect(screen.getByLabelText('Old ref')).toBe(box('field_old_ref'));
    expect(screen.getByText('No longer in the soft phone’s call details')).toBeTruthy();
    expect(screen.getByLabelText('Loan account no.')).toBe(box('field_loan_account_no'));

    // The analysis's labels and hints.
    expect(screen.getByLabelText('Analysis status')).toBe(box('analysis_status'));
    expect(screen.getByText('Says why a row has no analysis')).toBeTruthy();
    expect(screen.getByText('Positive, neutral, negative or mixed')).toBeTruthy();
    expect(screen.getByText('Joined with “; ”')).toBeTruthy();

    // Dimensions: named from the key, the type in words, a badge on a one-type dimension.
    expect(screen.getByLabelText('Promise strength')).toBe(box('dim_promise_strength'));
    expect(screen.getByText('Choice: firm, vague, none')).toBeTruthy();
    expect(screen.getByText('Changed type: Text, then Choice')).toBeTruthy();
    expect(screen.getByText('Found in stored results')).toBeTruthy();
    expect(screen.getByTestId('export-fields-badge-dim_callback_requested').textContent).toBe('Inbound');
    expect(screen.getByTestId('export-fields-badge-dim_reason_code').textContent).toBe('Dialler');
    expect(screen.queryByTestId('export-fields-badge-dim_promise_strength')).toBeNull();
    expect(screen.queryByTestId('export-fields-badge-dim_legacy_flag')).toBeNull();

    // Coverage, grouped the Indian way.
    expect(screen.getByTestId('export-fields-count-analysis_status').textContent).toBe('24,812 calls with a value');
    expect(screen.getByTestId('export-fields-count-dim_promise_strength').textContent).toMatch(/^9,120/);
  });

  it('Select all ticks a group and Clear unticks it, leaving the other groups alone', async () => {
    await ready();
    fireEvent.click(box('field_old_ref'));
    fireEvent.click(screen.getByRole('button', { name: 'Select all: Call analysis' }));
    for (const name of ['analysis_status', 'ai_summary', 'ai_sentiment', 'ai_sentiment_score', 'ai_key_topics']) {
      expect(box(name).checked).toBe(true);
    }
    expect(box('dim_promise_strength').checked).toBe(false);
    expect(box('field_old_ref').checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Clear: Call analysis' }));
    expect(box('ai_summary').checked).toBe(false);
    expect(box('field_old_ref').checked).toBe(true);

    // A group partly ticked offers Select all, which ticks the rest.
    fireEvent.click(screen.getByRole('button', { name: 'Select all: Call details the agent entered' }));
    expect(box('field_loan_account_no').checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear: Call details the agent entered' })).toBeTruthy();
  });

  it('with analysis off, says why in place of the analysis groups (CL47)', async () => {
    await ready(exportFieldsFixture({ analysis_available: false, analysed: null, analysis: [], dimensions: [] }));
    expect(screen.getByTestId('export-fields-analysis-off').textContent)
      .toBe('Call analysis is off for this account, so its fields can’t be added.');
    expect(screen.queryByTestId('export-fields-group-analysis')).toBeNull();
    expect(screen.queryByTestId('export-fields-group-dimensions')).toBeNull();
    expect(screen.getByTestId('export-fields-group-call_fields')).toBeTruthy();
    expect(screen.queryByTestId('export-fields-empty')).toBeNull();
  });
});

describe('the columns and the order they are sent in', () => {
  it('previews the chosen columns after the usual ones, in display order, and sends that order', async () => {
    const { onDownload } = await ready();
    expect(screen.getByTestId('export-fields-preview').textContent).toBe('attempt_id, contact_id, … missed_reason, callback_of');
    // Ticked in an order unlike the dialog's.
    fireEvent.click(box('dim_promise_strength'));
    fireEvent.click(box('ai_summary'));
    fireEvent.click(box('field_loan_account_no'));
    fireEvent.click(box('analysis_status'));
    const expected = ['field_loan_account_no', 'analysis_status', 'ai_summary', 'dim_promise_strength'];
    expect(previewChosen()).toEqual(expected);
    expect(screen.getByTestId('export-fields-preview').textContent)
      .toBe(`attempt_id, contact_id, … missed_reason, callback_of, ${expected.join(', ')}`);

    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    expect(onDownload).toHaveBeenCalledWith(expected);
  });
});

describe('the ceiling note (CL48)', () => {
  it('appears only with a field that lowers the ceiling, with the response’s numbers', async () => {
    await ready(exportFieldsFixture({ calls: 18_000, ai_row_limit: 20_000 }));
    fireEvent.click(box('analysis_status'));
    fireEvent.click(box('field_loan_account_no'));
    expect(screen.queryByTestId('export-fields-ceiling')).toBeNull();
    fireEvent.click(box('dim_callback_requested'));
    expect(screen.getByTestId('export-fields-ceiling').textContent).toBe('With AI fields the file holds at most 20,000 rows.');
    expect(screen.queryByTestId('export-fields-over-limit')).toBeNull();
  });

  it('adds how to get the rest only when the view holds more calls than the ceiling', async () => {
    await ready(exportFieldsFixture({ calls: 24_812, ai_row_limit: 20_000 }));
    fireEvent.click(box('ai_summary'));
    expect(screen.getByTestId('export-fields-over-limit').textContent)
      .toBe('This view has 24,812 calls: narrow the dates to get the rest.');
  });
});

describe('remembered fields (CL50)', () => {
  it('ticks the remembered fields the list offers, and keeps the others for a later view', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['ai_summary', 'dim_gone_since', 'field_old_ref']));
    const { onDownload } = await ready();
    expect(box('ai_summary').checked).toBe(true);
    expect(box('field_old_ref').checked).toBe(true);
    expect(previewChosen()).toEqual(['field_old_ref', 'ai_summary']);
    fireEvent.click(screen.getByTestId('export-fields-download'));
    // Only what this view offers is sent.
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith(['field_old_ref', 'ai_summary']));
    // The name this view did not offer is still remembered, after the choice made now.
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(['field_old_ref', 'ai_summary', 'dim_gone_since']);
  });

  it('a later view that offers the kept field ticks it again', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['ai_summary', 'dim_gone_since']));
    const base = exportFieldsFixture();
    const later = exportFieldsFixture({
      dimensions: [...base.dimensions, {
        name: 'dim_gone_since', key: 'gone_since', types: ['string'], options: [], description: null, calls: 3, sources: ['dialler'],
      }],
    });
    const { onClose } = await ready();
    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    cleanup();
    await ready(later);
    expect(box('dim_gone_since').checked).toBe(true);
    expect(box('ai_summary').checked).toBe(true);
  });

  it('unticking an offered remembered field forgets it', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['ai_summary', 'field_old_ref', 'dim_gone_since']));
    const { onClose } = await ready();
    fireEvent.click(box('ai_summary'));
    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(['field_old_ref', 'dim_gone_since']);
  });

  it('ticks nothing when nothing is remembered, and Remember is on by default', async () => {
    await ready();
    expect(document.querySelectorAll('input[data-field]:checked').length).toBe(0);
    expect((screen.getByTestId('export-fields-remember') as HTMLInputElement).checked).toBe(true);
  });

  it('saves on Download only, not on every click', async () => {
    const { onClose } = await ready();
    fireEvent.click(box('ai_summary'));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(['ai_summary']);
  });

  it('unticking Remember and downloading forgets the choice', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['ai_summary']));
    const { onClose } = await ready();
    fireEvent.click(screen.getByTestId('export-fields-remember'));
    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('works with storage blocked: nothing ticked, and Download still downloads', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { onDownload, onClose } = await ready();
    expect(document.querySelectorAll('input[data-field]:checked').length).toBe(0);
    fireEvent.click(box('ai_summary'));
    fireEvent.click(screen.getByTestId('export-fields-download'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDownload).toHaveBeenCalledWith(['ai_summary']);
  });
});

describe('downloading', () => {
  it('with nothing ticked, Download is disabled and the hint says what to do', async () => {
    const { onDownload } = await ready();
    const button = screen.getByTestId('export-fields-download') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const hint = screen.getByTestId('export-fields-nothing-chosen');
    expect(hint.textContent).toBe('Tick at least one field, or use Export CSV for the usual file.');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(button);
    expect(onDownload).not.toHaveBeenCalled();

    fireEvent.click(box('dim_promise_strength'));
    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('export-fields-nothing-chosen')).toBeNull();
    // Unticking the last one brings it back.
    fireEvent.click(box('dim_promise_strength'));
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('export-fields-nothing-chosen')).toBeTruthy();
  });

  it('disables Download while the file is prepared, and closes when it is done', async () => {
    let finish!: () => void;
    mocks.getCallExportFields.mockResolvedValue(exportFieldsFixture());
    const { onClose } = renderDialog({ onDownload: () => new Promise<void>((r) => { finish = r; }) });
    await screen.findByText('Columns in the file');
    fireEvent.click(box('ai_summary'));
    const button = screen.getByTestId('export-fields-download') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Preparing…');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalled();
  });

  it('nothing closes it while the file is prepared: not Escape, Cancel, the close button or the overlay', async () => {
    let finish!: () => void;
    mocks.getCallExportFields.mockResolvedValue(exportFieldsFixture());
    const { onClose } = renderDialog({ onDownload: () => new Promise<void>((r) => { finish = r; }) });
    await screen.findByText('Columns in the file');
    fireEvent.click(box('ai_summary'));
    fireEvent.click(screen.getByTestId('export-fields-download'));

    fireEvent.keyDown(document, { key: 'Escape' });
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new ApiError(403, { code: 'export_fields_not_permitted', message: 'Forbidden' }), 'Call analysis is off for this account, so its fields can’t be exported.'],
    [new ApiError(400, { code: 'export_fields_invalid', message: 'Bad' }), 'One of the chosen fields can’t be exported. Close this and open Export with fields again.'],
    [new Error('The connection dropped.'), 'The connection dropped.'],
  ])('says a refusal beside the fields and stays open (%#)', async (err, copy) => {
    mocks.getCallExportFields.mockResolvedValue(exportFieldsFixture());
    const { onClose } = renderDialog({ onDownload: () => Promise.reject(err) });
    await screen.findByText('Columns in the file');
    fireEvent.click(box('ai_summary'));
    fireEvent.click(screen.getByTestId('export-fields-download'));
    expect((await screen.findByTestId('export-fields-download-error')).textContent).toBe(copy);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('export-fields-download') as HTMLButtonElement).disabled).toBe(false);
    // A refused download remembers nothing.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('Cancel and Escape close it', async () => {
    const { onClose } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
