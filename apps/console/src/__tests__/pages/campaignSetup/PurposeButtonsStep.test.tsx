import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { PurposeButtonsStep, type PurposeButtonsStepProps } from '../../../pages/campaigns/agency/setup/PurposeButtonsStep';
import { emptyCampaignConfig, type CampaignConfigState } from '../../../utils/agencyCampaignConfigForm';
import { collectionsStarterOutcomes } from '../../../utils/agency/collectionsStarter';
import { purposePreset } from '../../../utils/campaignSetup/purposePresets';

/**
 * Step 3, Purpose & buttons (CS2–CS4, CS13), as a supervisor meets it: a controlled component
 * held by a small page that keeps the config, as New campaign and Settings do.
 */

let latest: CampaignConfigState;

function Harness({
  initial = emptyCampaignConfig(),
  ...props
}: Partial<Omit<PurposeButtonsStepProps, 'config' | 'onChange'>> & { initial?: CampaignConfigState }) {
  const [config, setConfig] = useState(initial);
  latest = config;
  return (
    <PurposeButtonsStep
      config={config}
      onChange={(next) => {
        latest = next;
        setConfig(next);
      }}
      fieldErrors={props.fieldErrors ?? {}}
      mode={props.mode ?? 'create'}
      onPresetApplied={props.onPresetApplied}
      forceAdvancedOpen={props.forceAdvancedOpen}
      overrides={props.overrides}
    />
  );
}

function withButtons(dispositions = collectionsStarterOutcomes()): CampaignConfigState {
  return { ...emptyCampaignConfig(), dispositions };
}

const preset = (name: RegExp) => screen.getByRole('radio', { name });
const rows = () => within(screen.getByTestId('button-rows')).getAllByRole('listitem');
const rowLabels = () => rows().map((row) => row.querySelector('[class*="rowLabel"]')?.textContent);
const previewLabels = () => within(screen.getByTestId('preview-tiles')).getAllByRole('listitem').map((tile) => tile.querySelector('b')?.textContent);
const fold = () => screen.getByTestId('purpose-advanced') as HTMLDetailsElement;

function select(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe('PurposeButtonsStep: starting points (CS2)', () => {
  it('shows the five starting points, with the one the buttons still are picked', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'What is this campaign for?' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['payment', 'sales', 'survey', 'appointment', 'blank']);
    expect((preset(/Start blank/) as HTMLInputElement).checked).toBe(true);
    expect(rowLabels()).toEqual(['Voicemail', 'Callback', 'Do not call']);
  });

  it('a loaded campaign that is no starting point has none picked', () => {
    const custom = collectionsStarterOutcomes();
    custom[0]!.label = 'Promised';
    render(<Harness initial={withButtons(custom)} mode="edit" />);
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });

  it('fills the buttons from an untouched starting point without asking, and tells the page', () => {
    const onPresetApplied = vi.fn();
    render(<Harness onPresetApplied={onPresetApplied} />);
    fireEvent.click(preset(/Sales \/ leads/));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(latest.dispositions).toEqual(purposePreset('sales').outcomes());
    expect(rowLabels()).toEqual(['Interested', 'Call later', 'No one spoke', 'Not interested', 'Wrong number', "Don't call again"]);
    expect((preset(/Sales \/ leads/) as HTMLInputElement).checked).toBe(true);
    expect(onPresetApplied).toHaveBeenCalledWith('sales');
  });

  it('asks before replacing buttons that were changed; Cancel keeps them, Replace swaps them', () => {
    const onPresetApplied = vi.fn();
    render(<Harness onPresetApplied={onPresetApplied} />);
    fireEvent.click(screen.getByTestId('button-edit-0'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Machine' } });
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);

    fireEvent.click(preset(/Payment reminder/));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Replace the buttons?')).toBeTruthy();
    expect(within(dialog).getByText(/The Payment reminder buttons will replace the 3 buttons you have now/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(latest.dispositions[0]!.label).toBe('Machine');
    expect(onPresetApplied).not.toHaveBeenCalled();

    fireEvent.click(preset(/Payment reminder/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replace buttons' }));
    expect(latest.dispositions).toEqual(collectionsStarterOutcomes());
    expect(onPresetApplied).toHaveBeenCalledWith('payment');
  });

  it('says in Settings that nothing changes until the save', () => {
    const custom = collectionsStarterOutcomes().slice(0, 5);
    render(<Harness initial={withButtons(custom)} mode="edit" />);
    fireEvent.click(preset(/Appointment/));
    expect(screen.getByRole('dialog').textContent).toContain('Nothing changes until you save.');
  });
});

describe('PurposeButtonsStep: the buttons (CS3)', () => {
  it('shows each button with its key, name and what it does', () => {
    render(<Harness initial={withButtons()} />);
    const first = rows()[0]!;
    expect(first.querySelector('kbd')?.textContent).toBe('Key 1');
    expect(first.textContent).toContain('Will pay');
    expect(screen.getByTestId('button-summary-0').textContent).toBe('Agent picks pay date & amount · counts as success · no follow-up call');
    expect(screen.getByTestId('button-summary-2').textContent).toBe('Try again after 4 hours, up to 2 times');
    expect(screen.getByTestId('button-count').textContent).toBe('6 of 6');
    expect(screen.getByTestId('button-count').getAttribute('data-tone')).toBe('muted');
  });

  it('warns above six, and says when agents see More', () => {
    const seven = [...collectionsStarterOutcomes(), { code: 'paid', label: 'Already paid' }];
    const { unmount } = render(<Harness initial={withButtons(seven)} />);
    expect(screen.getByTestId('button-count').textContent).toBe('7 of 6');
    expect(screen.getByTestId('button-count').getAttribute('data-tone')).toBe('warning');
    expect(screen.getByTestId('button-count-note').textContent).toBe('With this many, agents see smaller buttons.');
    unmount();
    const ten = [...seven, { code: 'a', label: 'A' }, { code: 'b', label: 'B' }, { code: 'c', label: 'C' }];
    render(<Harness initial={withButtons(ten)} />);
    expect(screen.getByTestId('button-count-note').textContent).toContain('the first 8, and the rest behind More');
  });

  it('Edit opens the sentence in place and reads Close; the sentence writes the rule', () => {
    render(<Harness initial={withButtons()} />);
    const edit = screen.getByTestId('button-edit-2');
    expect(edit.textContent).toBe('Edit');
    fireEvent.click(edit);
    expect(edit.textContent).toBe('Close');
    expect(edit.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('button-sentence-2').textContent).toContain('When the agent picks No one spoke →');
    expect(screen.getByTestId('button-sentence-2').textContent).toContain('Then stop calling.');

    select('button-delay-2', '60');
    select('button-attempts-2', '3');
    expect(latest.dispositions[2]).toEqual({ code: 'no_one_spoke', label: 'No one spoke', retry: { delay_minutes: 60, max_attempts: 3 }, icon: 'phone_missed' });
    expect(screen.getByTestId('button-summary-2').textContent).toBe('Try again after 1 hour, up to 3 times');

    select('button-action-2', 'finish');
    expect(latest.dispositions[2]).toEqual({ code: 'no_one_spoke', label: 'No one spoke', terminal: true, icon: 'phone_missed' });
    expect(screen.queryByTestId('button-delay-2')).toBeNull();
    select('button-success-2', 'yes');
    select('button-note-2', 'yes');
    expect(screen.getByTestId('button-summary-2').textContent).toBe('Agent writes a note · counts as success · stop calling');

    fireEvent.click(edit);
    expect(screen.queryByTestId('button-sentence-2')).toBeNull();
  });

  it('keeps a built-in’s action fixed and it cannot be removed', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-edit-5'));
    const options = Array.from((screen.getByTestId('button-action-5') as HTMLSelectElement).options);
    expect(options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['dnc']);
    expect(screen.getByTestId('button-locked-5').textContent).toContain('always puts the number on the Do Not Call list');
    expect((screen.getByTestId('button-remove-5') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a button, and the preview follows', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-edit-3'));
    fireEvent.click(screen.getByTestId('button-remove-3'));
    expect(latest.dispositions.map((d) => d.code)).toEqual(['will_pay', 'callback', 'no_one_spoke', 'wrong_number', 'do_not_call']);
    expect(previewLabels()).toEqual(['Will pay', 'Call later', 'No one spoke', 'Wrong number', "Don't call again"]);
    expect(screen.queryByTestId('button-sentence-3')).toBeNull();
  });

  it('moves buttons with keyboard-reachable buttons; the open row moves with its button', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-edit-0'));
    const down = screen.getByRole('button', { name: 'Move the Will pay button down' });
    expect(down.tagName).toBe('BUTTON');
    expect((screen.getByRole('button', { name: 'Move the Will pay button up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(down);
    expect(latest.dispositions.map((d) => d.code).slice(0, 2)).toEqual(['callback', 'will_pay']);
    expect(rowLabels().slice(0, 2)).toEqual(['Call later', 'Will pay']);
    expect(previewLabels().slice(0, 2)).toEqual(['Call later', 'Will pay']);
    expect(screen.getByTestId('button-sentence-1').textContent).toContain('When the agent picks Will pay');
    expect((screen.getByRole('button', { name: "Move the Don't call again button down" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a button with its name focused; the code follows the name and Advanced stays shut', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-add'));
    expect(rows()).toHaveLength(7);
    const name = screen.getByLabelText('Button name');
    expect(document.activeElement).toBe(name);
    expect(fold().open).toBe(false);
    expect(screen.getByTestId('button-fix-6')).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Already paid' } });
    expect(latest.dispositions[6]).toEqual({ code: 'already_paid', label: 'Already paid' });
    expect(screen.queryByTestId('button-fix-6')).toBeNull();
    expect(fold().open).toBe(false);
  });

  it('says a clashing name in the name’s words, never the code, without opening Advanced', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-add'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Refused' } });
    const row = rows()[6]!;
    expect(row.textContent).toContain('Another button already has this name. Give this one a different name.');
    expect(row.textContent).not.toContain('refused');
    expect(fold().open).toBe(false);
    expect(screen.getByLabelText('Button name').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('shows a refused save on its row while the row is shut', () => {
    render(<Harness initial={withButtons()} fieldErrors={{ 'disposition_catalog[1].requires_datetime': 'Built-in code needs a time.' }} />);
    expect(rows()[1]!.textContent).toContain('Built-in code needs a time.');
    expect(screen.getByTestId('button-fix-1')).toBeTruthy();
    expect(fold().open).toBe(false);
  });
});

describe('PurposeButtonsStep: what the agent will see (CS4)', () => {
  it('draws the station’s tiles in order, under What happened?, as a picture with nothing to press', () => {
    render(<Harness initial={withButtons()} />);
    const preview = screen.getByTestId('agent-buttons-preview');
    expect(within(preview).getByRole('heading', { name: 'What the agent will see' })).toBeTruthy();
    expect(preview.textContent).toContain('What happened?');
    expect(preview.textContent).toContain('The order is the number key agents can press.');
    expect(previewLabels()).toEqual(['Will pay', 'Call later', 'No one spoke', 'Refused', 'Wrong number', "Don't call again"]);
    expect(within(preview).queryAllByRole('button')).toHaveLength(0);
    // The station's own picture for each tile.
    expect(screen.getByTestId('preview-tiles-0').getAttribute('data-icon')).toBe('rupee');
    expect(screen.getByTestId('preview-tiles-5').getAttribute('data-stop')).toBe('true');
  });

  it('follows a rename as it is typed', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-edit-3'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Will not pay' } });
    expect(previewLabels()[3]).toBe('Will not pay');
    expect(latest.dispositions[3]!.code).toBe('refused');
  });
});

describe('PurposeButtonsStep: Advanced (CS13)', () => {
  it('is folded, and holds the full editor and the unanswered-call outcomes on the same config', () => {
    render(<Harness initial={withButtons()} />);
    expect(fold().open).toBe(false);
    expect(screen.getByText('Advanced settings (most campaigns don’t need these)')).toBeTruthy();
    fireEvent.click(screen.getByText('Advanced settings (most campaigns don’t need these)'));
    expect(fold().open).toBe(true);
    expect(within(fold()).getByRole('heading', { name: 'All button details' })).toBeTruthy();
    expect(within(fold()).getByRole('heading', { name: 'When a call is not answered' })).toBeTruthy();

    fireEvent.change(within(fold()).getByLabelText('Outcome 4 label'), { target: { value: 'Said no' } });
    expect(rowLabels()[3]).toBe('Said no');
    fireEvent.change(within(fold()).getByLabelText('No answer'), { target: { value: 'no_one_spoke' } });
    expect(latest.outcomeDispositions).toEqual({ no_answer: 'no_one_spoke' });
  });

  it('offers overrides only while contact assignment is on', () => {
    const { unmount } = render(<Harness initial={withButtons()} forceAdvancedOpen />);
    expect(screen.queryByTestId('override-group-0')).toBeNull();
    unmount();
    render(<Harness initial={withButtons()} forceAdvancedOpen overrides />);
    expect(screen.getByTestId('override-group-0')).toBeTruthy();
  });

  it('opens when a finding lives in it, and is held open until it is fixed', () => {
    const granting = collectionsStarterOutcomes();
    granting[3] = { ...granting[3]!, override: {} };
    render(<Harness initial={withButtons(granting)} overrides />);
    expect(fold().open).toBe(true);
    expect(within(fold()).getByText('Pick at least one thing this outcome allows, or turn the override off.')).toBeTruthy();
    fireEvent.click(screen.getByText('Advanced settings (most campaigns don’t need these)'));
    expect(fold().open).toBe(true);
  });

  it('opens for a refused code from the server, and for an automatic outcome that no longer fits', () => {
    const { unmount } = render(<Harness initial={withButtons()} fieldErrors={{ 'disposition_catalog[0].code': 'Duplicate disposition code.' }} />);
    expect(fold().open).toBe(true);
    unmount();
    render(<Harness initial={{ ...withButtons(), outcomeDispositions: { busy: 'gone' } }} />);
    expect(fold().open).toBe(true);
  });

  it('opens when the page holds it open', () => {
    render(<Harness initial={withButtons()} forceAdvancedOpen />);
    expect(fold().open).toBe(true);
  });

  it('More options opens it at the button’s card in the full editor', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-edit-2'));
    act(() => {
      fireEvent.click(screen.getByTestId('button-more-2'));
    });
    expect(fold().open).toBe(true);
    expect(document.activeElement).toBe(within(fold()).getByLabelText('Outcome 3 label'));
  });

  it('a code typed under Advanced stays put when the name changes above', () => {
    render(<Harness initial={withButtons()} />);
    fireEvent.click(screen.getByTestId('button-add'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Paid' } });
    fireEvent.click(screen.getByText('Advanced settings (most campaigns don’t need these)'));
    fireEvent.change(within(fold()).getByLabelText('Outcome 7 code'), { target: { value: 'paid_already' } });
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Paid earlier' } });
    expect(latest.dispositions[6]).toEqual({ code: 'paid_already', label: 'Paid earlier' });
  });

  it('a mapped button keeps its automatic outcome through a rename above', () => {
    const initial = { ...withButtons(), outcomeDispositions: { no_answer: 'no_one_spoke' } };
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByTestId('button-add'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Ringing out' } });
    fireEvent.click(screen.getByText('Advanced settings (most campaigns don’t need these)'));
    fireEvent.change(within(fold()).getByLabelText('No answer'), { target: { value: 'ringing_out' } });
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Rang out' } });
    expect(latest.dispositions[6]!.code).toBe('rang_out');
    expect(latest.outcomeDispositions).toEqual({ no_answer: 'rang_out' });
  });
});

describe('PurposeButtonsStep: what the page brings (CS18, templates)', () => {
  it('puts the outcomes’ source in the buttons’ heading, and no other section’s', () => {
    render(
      <PurposeButtonsStep
        config={withButtons()}
        onChange={() => {}}
        fieldErrors={{}}
        mode="create"
        sectionSources={{ outcomes: <span data-testid="outcomes-source">Built-in</span>, hours: <span data-testid="hours-source" /> }}
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Buttons agents will see after each call' });
    const block = screen.getByTestId('buttons-block');
    expect(block.contains(screen.getByTestId('outcomes-source'))).toBe(true);
    // In the heading's row, beside the count, not among the buttons.
    expect(heading.parentElement?.parentElement?.contains(screen.getByTestId('outcomes-source'))).toBe(true);
    expect(screen.getByTestId('button-rows').contains(screen.getByTestId('outcomes-source'))).toBe(false);
    expect(screen.queryByTestId('hours-source')).toBeNull();
  });

  it('forgets the old rows when the page replaces the buttons: a name no longer writes the code, and no row stays open', () => {
    const replacement = withButtons([...collectionsStarterOutcomes(), { code: 'paid', label: 'Paid' }]);
    function Replacing() {
      const [config, setConfig] = useState(withButtons());
      const [replaced, setReplaced] = useState(0);
      latest = config;
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setConfig(replacement);
              setReplaced((n) => n + 1);
            }}
          >
            Replace from the page
          </button>
          <PurposeButtonsStep
            config={config}
            onChange={(next) => {
              latest = next;
              setConfig(next);
            }}
            fieldErrors={{}}
            mode="create"
            buttonsReplaced={replaced}
          />
        </>
      );
    }
    render(<Replacing />);
    // A new seventh button takes its code from its name while it is open.
    fireEvent.click(screen.getByTestId('button-add'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Paid late' } });
    expect(latest.dispositions[6]).toEqual({ code: 'paid_late', label: 'Paid late' });

    fireEvent.click(screen.getByRole('button', { name: 'Replace from the page' }));
    expect(latest.dispositions[6]).toEqual({ code: 'paid', label: 'Paid' });
    expect(screen.queryByTestId('button-sentence-6')).toBeNull();
    // The seventh row is the page's now: renaming it keeps its code.
    fireEvent.click(screen.getByTestId('button-edit-6'));
    fireEvent.change(screen.getByLabelText('Button name'), { target: { value: 'Paid in full' } });
    expect(latest.dispositions[6]).toEqual({ code: 'paid', label: 'Paid in full' });
  });
});

