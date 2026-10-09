import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NotesField } from '../../components/agency/NotesField';
import { notesStatus, NOTES_FOREIGN_WRITE_COPY, type NotesStatusInput } from '../../utils/agencyNotes';

/**
 * `NotesField`.
 *
 * The status-line rules are unit-tested in `agencyNotes`; what is only observable
 * here is that the tone reaches the DOM as a *distinction* and that `Esc` does not
 * cost the agent their notes.
 */

const BASE: NotesStatusInput = {
  notes: '',
  lastKeystrokeAt: null,
  lastSaveSucceededAt: null,
  lastUpdatedAt: null,
  inFlight: false,
  failure: null,
  acceptingWrites: true,
};

afterEach(cleanup);

function setup(
  props: Partial<Parameters<typeof NotesField>[0]> = {},
  statusInput: Partial<NotesStatusInput> = {},
) {
  const onAgentEdit = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <NotesField
      value=""
      onAgentEdit={onAgentEdit}
      status={notesStatus({ ...BASE, ...statusInput })}
      enabled
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onAgentEdit, onSubmit, ...utils };
}

const field = () => screen.getByLabelText(/Notes/) as HTMLTextAreaElement;
const status = () => screen.getByText((_t, node) => node?.id === 'agency-notes-status');

describe('Esc blurs and does NOT clear', () => {
  it('leaves the text intact', () => {
    // Unrecoverable if wrong: `Esc` means "get me out of here" everywhere else in
    // this console, and an agent will press it reflexively.
    const { onAgentEdit } = setup({ value: 'eight minutes of context' });
    const textarea = field();
    textarea.focus();

    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(textarea.value).toBe('eight minutes of context');
    // And nothing was reported upward that could clear it either — an `onAgentEdit('')`
    // here would reach the API client WITH agent provenance and wipe the server copy.
    expect(onAgentEdit).not.toHaveBeenCalled();
  });

  it('moves focus off the field', () => {
    setup({ value: 'text' });
    const textarea = field();
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(document.activeElement).not.toBe(textarea);
  });
});

describe('the component cannot fabricate agent provenance', () => {
  it('reports a real edit', () => {
    const { onAgentEdit } = setup();
    fireEvent.change(field(), { target: { value: 'typed' } });
    expect(onAgentEdit).toHaveBeenCalledWith('typed');
  });

  it('reports a real clear, because an agent emptying the field is legitimate', () => {
    const { onAgentEdit } = setup({ value: 'mistake' });
    fireEvent.change(field(), { target: { value: '' } });
    expect(onAgentEdit).toHaveBeenCalledWith('');
  });

  it('emits nothing when only the value prop changes', () => {
    // A re-render, a hydration, an attempt switch: none of these are edits, and
    // none of them may produce the provenance that licenses an empty save.
    const { onAgentEdit, rerender } = setup({ value: 'first' });
    rerender(
      <NotesField
        value="restored from localStorage"
        onAgentEdit={onAgentEdit}
        status={notesStatus(BASE)}
        enabled
      />,
    );
    expect(onAgentEdit).not.toHaveBeenCalled();
  });
});

describe('Ctrl/Cmd+Enter is one of the two keys that survive a text input', () => {
  it('submits on Ctrl+Enter', () => {
    const { onSubmit } = setup();
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Cmd+Enter', () => {
    const { onSubmit } = setup();
    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on a bare Enter — that is a newline in a note', () => {
    const { onSubmit } = setup();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('the status line carries the distinction in colour AND weight', () => {
  it('renders the resting copy muted', () => {
    setup();
    expect(status().textContent).toBe('Notes save as you type.');
    expect(status().getAttribute('data-tone')).toBe('muted');
  });

  it('says Saving… while a keystroke is newer than the last save', () => {
    setup({}, { notes: 'x', lastKeystrokeAt: 200, lastSaveSucceededAt: 100 });
    expect(status().textContent).toBe('Saving…');
  });

  it('shows the server’s timestamp once nothing is newer than the save', () => {
    // From `updated_at`, never local time — that is what makes the readout
    // falsifiable: an agent whose latest sentence did not land sees a timestamp
    // that has stopped advancing.
    setup(
      {},
      {
        notes: 'x',
        lastKeystrokeAt: 100,
        lastSaveSucceededAt: 200,
        lastUpdatedAt: '2026-08-11T14:32:00.000Z',
      },
    );
    expect(status().textContent).toMatch(/^Saved \d{2}:\d{2}$/);
    expect(status().getAttribute('data-tone')).toBe('muted');
  });

  it('is warning while a retry is pending — not there YET, still trying', () => {
    setup({}, { notes: 'x', lastKeystrokeAt: 200, failure: 'retryable' });
    expect(status().getAttribute('data-tone')).toBe('warning');
    expect(Number(status().style.fontWeight)).toBe(500);
  });

  it('is danger once retries are exhausted — it is not going to arrive', () => {
    setup({}, { notes: 'x', lastKeystrokeAt: 200, failure: 'terminal' });
    expect(status().getAttribute('data-tone')).toBe('danger');
    expect(Number(status().style.fontWeight)).toBe(600);
  });

  it('escalates weight with tone, so colour is never the only channel', () => {
    // A colour-blind agent, or a badly-calibrated agency-floor monitor,
    // must still see the difference.
    const weights = (['muted', 'warning', 'danger'] as const).map((tone) => {
      cleanup();
      const input: Partial<NotesStatusInput> =
        tone === 'muted'
          ? {}
          : { notes: 'x', lastKeystrokeAt: 200, failure: tone === 'warning' ? 'retryable' : 'terminal' };
      setup({}, input);
      return Number(status().style.fontWeight);
    });
    expect(weights).toEqual([400, 500, 600]);
  });
});

describe('the closed row is split, and the split is the point', () => {
  it('renders a clean close as muted — nothing is at risk', () => {
    // Do NOT render the benign outcome as danger: an alarm on a safe state is the
    // cry-wolf failure that keeps the last-write-wins caveat out of the resting copy.
    setup(
      { enabled: false },
      { notes: 'x', lastKeystrokeAt: 100, lastSaveSucceededAt: 200, acceptingWrites: false },
    );
    expect(status().textContent).toBe('Notes are closed for this call.');
    expect(status().getAttribute('data-tone')).toBe('muted');
  });

  it('renders a lossy close as danger and NAMES what was lost', () => {
    // The last thing the agent ever sees about that call. One string across both
    // outcomes was the single-"Saved" defect in miniature.
    setup(
      { enabled: false },
      { notes: 'mid-sentence', lastKeystrokeAt: 300, lastSaveSucceededAt: 100, acceptingWrites: false },
    );
    expect(status().textContent).toBe("Notes are closed for this call — your last edits weren't saved.");
    expect(status().getAttribute('data-tone')).toBe('danger');
  });

  it('counts an unresolved failure at close as lossy', () => {
    // The retry the agent was promised can no longer happen, even though the
    // keystroke ordering alone would not say so.
    setup(
      { enabled: false },
      { notes: 'x', lastKeystrokeAt: 100, lastSaveSucceededAt: 200, failure: 'retryable', acceptingWrites: false },
    );
    expect(status().getAttribute('data-state')).toBe('closed_lossy');
  });

  it('states why the field is disabled', () => {
    setup({ enabled: false, disabledReason: 'Notes open when a call connects.' });
    expect(field().disabled).toBe(true);
    expect(screen.getByText('Notes open when a call connects.')).toBeTruthy();
  });
});

describe('the foreign-write notice coexists with any state', () => {
  it('renders alongside a successful save rather than replacing it', () => {
    setup(
      { foreignWrite: true },
      {
        notes: 'x',
        lastKeystrokeAt: 100,
        lastSaveSucceededAt: 200,
        lastUpdatedAt: '2026-08-11T14:32:00.000Z',
      },
    );
    expect(status().textContent).toMatch(/^Saved/);
    expect(screen.getByText(NOTES_FOREIGN_WRITE_COPY)).toBeTruthy();
  });

  it('is warning — it arrived, but someone else’s version is also in play', () => {
    setup({ foreignWrite: true });
    expect(screen.getByText(NOTES_FOREIGN_WRITE_COPY).getAttribute('data-tone')).toBe('warning');
  });

  it('is absent by default, so it cannot become resting noise', () => {
    setup();
    expect(screen.queryByText(NOTES_FOREIGN_WRITE_COPY)).toBeNull();
  });
});

describe('the field is not a keyboard trap', () => {
  it('does not stop propagation, so the page still sees Tab and Esc', () => {
    // `stopPropagation` on the textarea would also swallow `Esc`, which the page's
    // handler needs. The suppression of single-key shortcuts is the PAGE's job,
    // decided by where focus is.
    const seen: string[] = [];
    const { container } = render(
      <div onKeyDown={(e) => seen.push(e.key)}>
        <NotesField value="" onAgentEdit={vi.fn()} status={notesStatus(BASE)} enabled />
      </div>,
    );
    const textarea = container.querySelector('textarea')!;
    fireEvent.keyDown(textarea, { key: 'Tab' });
    fireEvent.keyDown(textarea, { key: 'b' });
    expect(seen).toEqual(['Tab', 'b']);
  });
});
