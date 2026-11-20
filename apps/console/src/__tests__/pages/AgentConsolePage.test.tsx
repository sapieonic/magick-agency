import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  useTenant: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
const analyticsMocks = vi.hoisted(() => ({ trackAgencyHangupRequested: vi.fn() }));
// Every other emitter passes through to the real (no-op-without-a-key) one.
vi.mock('../../analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics/events')>();
  return { ...actual, trackAgencyHangupRequested: analyticsMocks.trackAgencyHangupRequested };
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { stubStationMicrophone } from '../helpers/stationDevices';
import { ApiError } from '../../api/client';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * The Agent Console page — **usable end to end
 * without a mouse**.
 *
 * ── The assertion discipline this file is written to ──────────────────────────
 * An earlier change found a focus assertion that survived a 250ms timing change while
 * `End break` was in fact keyboard-**unreachable**: the shortcut worked, so
 * nothing looked broken unless you navigated by focus. So nothing here asserts
 * that a handler exists or that a component was rendered with the right props.
 * Every keyboard test drives a real `keydown` on `window` — the same event a
 * keyboard reaches the page with — and asserts the **observable consequence**
 * (a request sent, a menu open, focus moved). A test that pokes a callback
 * directly cannot tell a bound shortcut from an unbound one.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: { 'First Name': 'Asha' },
  prior_attempts: [],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [
    { code: 'sale', label: 'Sale' },
    { code: 'callback', label: 'Call back later', requires_note: true },
  ],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [{ code: 'lunch', label: 'Lunch' }],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

/**
 * A contact with more than one tier-2 field, for the filter tests.
 * `hero: ['First Name']` pins the hero row explicitly so the heuristic never
 * runs — otherwise `City`/`Branch` (place-ish) would compete with the heuristic
 * for a hero slot and which fields land in tier 2 would depend on bucket order
 * rather than the fixture, exactly the ambiguity `agencyContext.test.ts` avoids
 * the same way.
 */
const FILTER_ATTEMPT: AgencyReservedAttempt = {
  ...ATTEMPT,
  context: {
    'First Name': 'Asha',
    City: 'Mumbai',
    Branch: 'Andheri West',
    'Vehicle Model': 'Verna',
  },
};

const FILTER_BOOTSTRAP: AgencySessionBootstrap = {
  ...BOOTSTRAP,
  context_display: { hero: ['First Name'] },
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.setAgentBreak.mockResolvedValue({ session_id: 'sess-1', state: 'break' });
  mocks.submitDisposition.mockResolvedValue({
    attempt_id: 'att-1',
    contact_id: 'c-1',
    disposition_code: 'sale',
    contact_state: 'completed',
    next_attempt_at: null,
    agent_state: 'available',
  });
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/app/agency/console?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  // Session bootstrap, then the station socket.
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

/** Bridged and talking, with `agent_state` following as the API sends it. */
async function onCall() {
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt: ATTEMPT });
    latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
    latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
  });
  return view;
}

/**
 * Same shape as `onCall`, but for a caller-supplied attempt/bootstrap — the
 * filter tests below need a contact with more than one tier-2 field, and
 * `ATTEMPT`'s single `First Name` column is claimed by the hero heuristic,
 * leaving nothing in tier 2 to filter.
 */
async function onCallWithContext(
  attempt: AgencyReservedAttempt,
  bootstrap: AgencySessionBootstrap = BOOTSTRAP,
) {
  mocks.createAgencySession.mockResolvedValue(bootstrap);
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt });
    latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
    latest().emit({
      event: 'bridged',
      attempt_id: attempt.attempt_id,
      bridged_at: '2026-08-11T10:00:04.000Z',
    });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
  });
  return view;
}

/**
 * Tomorrow, 10:00, in the shape a `datetime-local` input takes and in the agent's
 * own zone — which is the zone `DispositionPad` works in.
 */
function tomorrowLocal(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

/**
 * A real keypress, at the element the browser would actually target — the focused
 * one. Defaulting to `document` bypasses the page's `inTextField` guard entirely,
 * which is how that guard shipped treating a `radio` as a text field and killing
 * every page shortcut inside the cue-settings popover (`NON_TEXT_INPUT_TYPES`).
 *
 * **Prophylactic here, not a fix.** Measured: with the guard broken back to
 * `tag === 'INPUT'`, this file's cases pass either way — none of them presses a
 * single key while focus is inside an `<input>`, so the retarget catches nothing
 * today. It is the default that keeps the *next* keyboard case in this file honest,
 * since this is where criterion (d) lives and it will grow. The case that does
 * catch it is in `AgentConsolePage.cueVisual.test.tsx`.
 *
 * Pass an explicit target only when a specific element is the point of the test.
 */
function press(key: string, target: Element | Document = document.activeElement ?? document) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

describe('the station’s top bar names the agent and today’s work (spec §3)', () => {
  it('puts the signed-in name in the top bar next to the work', async () => {
    await mounted();
    const name = screen.getByTestId('station-agent');
    expect(name.textContent).toBe('Asha Kumar');
    expect(screen.getByTestId('station-work').textContent).toBe('Renewals');
    expect(name.closest('header')).not.toBeNull();
  });

  it('offers ⋮ More as a labelled button with its picture', async () => {
    await mounted();
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('opens on Start of day, with Start work as its one main action, and moves to Call coming when a call lands', async () => {
    await mounted();
    expect(screen.getByTestId('band-title').textContent).toBe('Namaste, Asha');
    expect(screen.getByRole('button', { name: /start work/i })).toBeTruthy();
    // AS1: nothing that belongs to another state is on the screen, not even disabled.
    expect(screen.queryByRole('button', { name: /take break/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /end call/i })).toBeNull();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Call coming');
    expect(screen.queryByRole('button', { name: /start work/i })).toBeNull();
  });
});

describe('AgentConsolePage: one state, one screen (AS1)', () => {
  it('shows each state’s own main action and hides the rest', async () => {
    await mounted();
    expect(screen.getByTestId('station').getAttribute('data-screen')).toBe('start');

    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T09:59:00.000Z' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
    expect(screen.getByRole('button', { name: /take break/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /start work/i })).toBeNull();
  });

  it('opens the call on bridged and not on a diagnostic status frame', async () => {
    const view = await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
      // Bridge-originated and DIAGNOSTIC. The carrier says the far end went
      // off-hook; it does not say audio reaches this agent.
      latest().emit({ event: 'status', attempt_id: 'att-1', status: 'answered' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Call coming');
    expect(view.container.querySelector('[data-testid="talk-timer"]')).toBeNull();
    // AS11: no stop button on Call coming; the call connects by itself.
    expect(screen.queryByRole('button', { name: /end call/i })).toBeNull();
    expect(screen.getByText('The call connects by itself.')).toBeTruthy();

    await act(async () => {
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('On call');
    expect(screen.getByTestId('talk-timer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hold to end call' })).toBeTruthy();
  });
});

describe('focus moves once per call, on the reservation', () => {
  it('moves to the station body when a call is reserved', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    expect(document.activeElement).toBe(screen.getByTestId('station-body'));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('does NOT move again when a reconnect restates the same ringing attempt', async () => {
    /**
     * A `ready` on reconnect replaces `live` with a fresh object for the SAME
     * attempt. Keyed on the whole `live`, the focus effect read that as a new call
     * and pulled focus back to the console root — a second steal, mid-ring, from
     * wherever the agent had moved it (the notes, the break menu). Focus moves
     * exactly once per call, so it is keyed on the attempt id.
     */
    await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    const elsewhere = screen.getByRole('button', { name: 'More' });
    act(() => elsewhere.focus());
    expect(document.activeElement).toBe(elsewhere);

    await act(async () => {
      latest().emit({ event: 'ready', state: 'reserved', active_attempt: { ...ATTEMPT, bridged_at: null } });
    });

    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('criterion (d) — reachable and operable from the keyboard', () => {
  it('A goes available from offline, without the pointer', async () => {
    await mounted();

    press('a');

    // The observable consequence, not the handler. A shortcut that is declared but
    // never bound passes any assertion about the button's existence.
    await act(async () => {});
    expect(mocks.setAgentAvailable).toHaveBeenCalledWith('sess-1', 'tenant-1', 'account-1');
  });

  it('A ends a break, the state where it is the only control', async () => {
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'agent_state',
        state: 'break',
        break_reason: 'lunch',
        since: '2026-08-11T10:00:00.000Z',
      });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('On break · Lunch');
    expect(screen.getByRole('button', { name: /start calls again/i })).toBeTruthy();

    press('a');
    await act(async () => {});

    expect(mocks.setAgentAvailable).toHaveBeenCalledTimes(1);
  });

  it('names the mobile app\'s device-away break by its label if this station ever sees it (no catalog lists it)', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'break', break_reason: 'device_away', since: '2026-08-11T10:00:00.000Z' });
    });
    // The app's own pause reads Paused (spec 07), with its label, never the code.
    expect(screen.getByTestId('band-title').textContent).toBe('Paused');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Away (app in background)');
  });

  it('names the app\'s phone-call pause (IQ51) by its label too, never the code', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'break', break_reason: 'phone_call', since: '2026-08-11T10:00:00.000Z' });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Paused');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('On a phone call');
  });

  it('B opens Which break? and lands focus inside it', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T09:59:00.000Z' });
    });

    press('b');

    // A dialog present AND focus moved into it: one a keyboard agent cannot reach is a defect.
    const dialog = screen.getByRole('dialog', { name: 'Which break?' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('Esc closes Which break? and returns focus to Take break', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T09:59:00.000Z' });
    });
    press('b');
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    const trigger = screen.getByRole('button', { name: /take break/i });

    press('Escape', document.activeElement ?? document);

    expect(screen.queryByRole('dialog')).toBeNull();
    // Never `<body>`: that strands a keyboard agent at the top of the document.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('a digit in Which break? starts that break, and never picks an outcome under it', async () => {
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T09:59:00.000Z' });
    });
    press('b');
    press('1');
    await act(async () => {});
    expect(mocks.setAgentBreak).toHaveBeenCalledWith('sess-1', 'lunch', 'tenant-1', 'account-1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a number key picks the catalog entry at that index, in the API’s order', async () => {
    await onCall();

    press('2');

    // Index 2 is `callback`, which sets `requires_note` — so the note card asks for one,
    // and focus is moved to the field.
    expect(screen.getByTestId('note-needed').textContent).toBe('Write a note for this one.');
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });

  it('suppresses single-key shortcuts while focus is in the notes field', async () => {
    await onCall();
    press('n');
    const notes = document.activeElement as HTMLTextAreaElement;
    expect(notes.tagName).toBe('TEXTAREA');

    // Typing a note containing "b" must not open the break menu mid-sentence.
    press('b', notes);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Ctrl+Enter submits from inside the notes field, which Esc must not', async () => {
    await onCall();
    press('2');
    const notes = document.activeElement as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: 'Asked for a call back Tuesday.' } });

    // Esc blurs and MUST NOT clear: destroying an eight-minute call's notes on a
    // stray Esc is unrecoverable.
    press('Escape', notes);
    expect(notes.value).toBe('Asked for a call back Tuesday.');

    act(() => {
      fireEvent.keyDown(notes, { key: 'Enter', ctrlKey: true });
    });
    await act(async () => {});

    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
    expect(mocks.submitDisposition.mock.calls[0]![1]).toMatchObject({
      disposition_code: 'callback',
      notes: 'Asked for a call back Tuesday.',
    });
  });

  it('Ctrl+Enter submits with focus OUTSIDE the notes field', async () => {
    /**
     * The page's own binding, which the in-field test cannot see: `NotesField`
     * handles `Ctrl+Enter` itself, so a test that submits from inside the textarea
     * passes with the page's global handler deleted. Found by mutation — the page
     * handler looked covered and was not.
     *
     * It matters because an agent who picked an outcome with `1` has focus on the
     * pad, not the notes, and this shortcut matters because "call 200 is the
     * difference between a tool and a punishment".
     */
    await onCall();
    press('1');
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    });
    await act(async () => {});

    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
  });

  it('every control in the footer is reachable by Tab, the main action last (AS1)', async () => {
    await onCall();
    /**
     * Reachability, not presence. A control rendered inside a container that is
     * `aria-hidden`, or carrying `tabIndex={-1}`, renders and reads correctly and
     * cannot be tabbed to — which is exactly how `End break` once shipped unreachable.
     * So this walks the document's own tab order, inside the footer.
     */
    const footer = screen.getByTestId('station').querySelector('footer')!;
    const tabbable = Array.from(footer.querySelectorAll<HTMLElement>('button, textarea, [tabindex]')).filter(
      (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex >= 0,
    );
    const names = tabbable.map((el) => el.textContent?.trim() ?? '');
    // The microphone is not open in this file (no capture), so Mute is hidden (AS1); End call is
    // the footer's last control, bottom right.
    expect(names[names.length - 1]).toBe('Hold to end call');
    // AS10: no break button on the call.
    expect(names.some((n) => /break/i.test(n))).toBe(false);
    // Need help is floor assist's, off here: not on the screen at all.
    expect(screen.queryByRole('button', { name: /Need help/ })).toBeNull();
  });

  it('keeps the main action bottom right: the footer pushes it to the far end (AS1)', async () => {
    await onCall();
    const css = readFileSync(resolve(__dirname, '../../components/agency/station/Station.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.footRight \{[^}]*margin-left: auto;/);
    // The shortcuts are as they were: Ctrl+Enter still saves.
    press('1');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    });
    await act(async () => {});
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── Criterion (c), at the page rather than in the pure function ────────────────
 *
 * `agencyDispositionForm.test.ts` already pins the rule (`noteSatisfied` trims, so
 * whitespace is not a note) and the API pins the same rule server-side
 * (`disposition.ts` → `notesRaw.trim()`, tested in `disposition.test.ts` and
 * `disposition-route.test.ts`). Neither of those can see the **wiring**, and the
 * wiring is where this criterion was actually broken: the block was computed over
 * `form.notes`, which has no writer at all, while the note the agent types lands in
 * `notes`. So the guard was permanently on for any `requires_note` code — Save could
 * never enable and the stated reason never cleared — and the only path that worked
 * was `NotesField`'s own `Ctrl+Enter`, which bypasses the block and re-validates
 * over the merged notes inside `submit`.
 */
/**
 * ── Criterion (d), as one run rather than as a set of shortcuts ─────────────────
 *
 * Every test in the block above proves one key does one thing. None of them proves
 * the criterion, which is that a shift can be *worked* without a pointer: a set of
 * individually-reachable controls can still leave a gap — a step with no key at all,
 * or a key that only works from a focus position the previous step does not leave you
 * in — and each of them passes its own test. That defect is the standing example
 * (`End break` was operable by shortcut and unreachable by focus, so nothing looked
 * broken), and the `C` and `/` shortcuts were the two remaining holes in this path.
 *
 * So this is the whole path, in order, in one test: offline → available → reserved →
 * read the context (with the `/` filter) → bridged → hang up → wrap-up → disposition
 * → note → save → available, with a break queued along the way.
 *
 * ── What "no pointer" is asserted as ─────────────────────────────────────────────
 * A capture listener for every pointer event type, plus a patch over
 * `HTMLElement.prototype.click`. Nothing in the run may produce one — including a
 * `.click()` a component might call on the agent's behalf, which is the loophole a
 * "we only used `fireEvent.keyDown`" claim by construction cannot close. Note this is
 * strict on purpose: keyboard activation of a `<button>` does dispatch a `click` in a
 * real browser, so the run deliberately routes through the paths that do **not** need
 * button activation (the break menu's own `Enter` handler; the callback time through
 * its `datetime-local` input) — if a step could only be completed by activating a
 * button, that is exactly what this test should refuse to hide.
 */
describe('criterion (d) — a whole call worked without a pointer', () => {
  const POINTER_EVENTS = [
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    'mousemove',
    'pointerdown',
    'pointerup',
    'pointermove',
    'contextmenu',
  ] as const;

  function watchForPointerUse() {
    const seen: string[] = [];
    const record = (event: Event) => {
      const target = event.target as HTMLElement | null;
      seen.push(`${event.type} on <${target?.tagName?.toLowerCase() ?? '?'}>`);
    };
    for (const type of POINTER_EVENTS) document.addEventListener(type, record, true);

    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function patched(this: HTMLElement) {
      seen.push(`.click() on <${this.tagName.toLowerCase()}>`);
      return nativeClick.call(this);
    };

    return {
      seen,
      stop() {
        for (const type of POINTER_EVENTS) document.removeEventListener(type, record, true);
        HTMLElement.prototype.click = nativeClick;
      },
    };
  }

  /**
   * A campaign whose callback code needs **both** a note and a time, so the run has
   * to satisfy the two requirements the criterion's own surfaces impose, and
   * a contact with enough tier-2 fields for the filter to have something to hide.
   */
  const FLOW_BOOTSTRAP: AgencySessionBootstrap = {
    ...BOOTSTRAP,
    context_display: { hero: ['First Name'] },
    disposition_catalog: [
      { code: 'sale', label: 'Sale', is_success: true },
      {
        code: 'callback',
        label: 'Call back later',
        requires_note: true,
        requires_datetime: true,
      },
    ],
  };

  it('offline → available → reserved → read → bridged → hang up → wrap-up → save → available', async () => {
    mocks.createAgencySession.mockResolvedValue(FLOW_BOOTSTRAP);
    mocks.hangupAttempt.mockResolvedValue(undefined);
    // A break requested mid-call is queued, not taken — the API answers with the
    // pending state, which is what puts the pill on screen.
    mocks.setAgentBreak.mockResolvedValue({
      session_id: 'sess-1',
      state: 'on_call',
      pending_state: 'break',
      break_reason: 'lunch',
    });
    mocks.submitDisposition.mockResolvedValue({
      attempt_id: 'att-1',
      contact_id: 'c-1',
      disposition_code: 'callback',
      contact_state: 'callback',
      next_attempt_at: '2026-08-12T10:00:00.000Z',
      agent_state: 'available',
    });

    const pointer = watchForPointerUse();
    try {
      await mounted();
      expect(screen.getByTestId('band-title').textContent).toBe('Namaste, Asha');

      // ── 1. Go available ───────────────────────────────────────────────────────
      press('a');
      await act(async () => {});
      expect(mocks.setAgentAvailable).toHaveBeenCalledWith('sess-1', 'tenant-1', 'account-1');
      await act(async () => {
        latest().emit({
          event: 'agent_state',
          state: 'available',
          since: '2026-08-11T09:59:00.000Z',
        });
      });
      expect(screen.getByTestId('band-title').textContent).toBe('Ready');

      // ── 2. A call is reserved ─────────────────────────────────────────────────
      await act(async () => {
        latest().emit({ event: 'reserved', attempt: FILTER_ATTEMPT });
        latest().emit({
          event: 'agent_state',
          state: 'reserved',
          since: '2026-08-11T10:00:00.000Z',
        });
      });
      expect(screen.getByTestId('band-title').textContent).toBe('Call coming');

      // ── 3. Read who is coming ─────────────────────────────────────────────────
      // The card names the customer from the campaign's columns; focus is on the body, not in a field.
      expect(screen.getByTestId('customer-name').textContent).toBe('Asha');
      expect(document.activeElement?.tagName).not.toBe('INPUT');

      // ── 4. The customer answers ───────────────────────────────────────────────
      await act(async () => {
        latest().emit({
          event: 'bridged',
          attempt_id: FILTER_ATTEMPT.attempt_id,
          bridged_at: '2026-08-11T10:00:04.000Z',
        });
        latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
      });
      expect(screen.getByTestId('band-title').textContent).toBe('On call');
      expect(screen.getByTestId('talk-timer')).toBeTruthy();

      // ── 5. Book a break for after this call (AS10: `B`, no button on the call) ──
      press('b');
      expect(screen.getByRole('dialog', { name: 'Which break?' })).toBeTruthy();
      // The reason's digit, handled by the dialog itself — no activation of a button, so no click.
      press('1');
      await act(async () => {});
      expect(mocks.setAgentBreak).toHaveBeenCalledWith('sess-1', 'lunch', 'tenant-1', 'account-1');
      expect(screen.getByTestId('queued-break').textContent).toContain('Lunch break after this call');
      expect(screen.queryByRole('dialog')).toBeNull();

      // ── 6. End the call ───────────────────────────────────────────────────────
      press('e');
      press('e');
      expect(mocks.hangupAttempt).toHaveBeenCalledWith(
        FILTER_ATTEMPT.attempt_id,
        'tenant-1',
        'account-1',
      );

      // ── 7. Wrap-up opens ──────────────────────────────────────────────────────
      await act(async () => {
        latest().emit({
          event: 'released',
          attempt_id: FILTER_ATTEMPT.attempt_id,
          reason: 'agent_hangup',
          requires_disposition: true,
          message: 'You ended the call.',
        });
        latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
        latest().emit({
          event: 'wrapup',
          wrapup: {
            attempt_id: FILTER_ATTEMPT.attempt_id,
            ends_at: '2026-08-11T10:05:30.000Z',
            requires_disposition: true,
            disposition_submitted: false,
            auto_return: true,
          },
        });
      });
      expect(screen.getByTestId('band-title').textContent).toBe('What happened?');
      expect(screen.getByTestId('wrapup-digits')).toBeTruthy();

      // ── 8. Pick Call later with `C` ───────────────────────────────────────────
      press('c');
      // The callback row does not exist until the selection renders it, so the pad
      // defers the focus move by a frame.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId('outcome-callback').getAttribute('aria-pressed')).toBe('true');
      const firstChip = screen.getByRole('button', { name: 'In 1 hour' });
      expect(document.activeElement).toBe(firstChip);

      // ── 9. Give it a time, through the field rather than the chips ────────────
      // Computed from the real present rather than hard-coded: `blockReason` refuses
      // a callback in the past, and a fixed date would start failing the day it
      // passed — for a reason that has nothing to do with the keyboard.
      const picker = screen.getByLabelText('Callback date and time') as HTMLInputElement;
      fireEvent.change(picker, { target: { value: tomorrowLocal() } });
      expect(screen.getByTestId('callback-resolved')).toBeTruthy();

      // ── 10. Write the note ────────────────────────────────────────────────────
      press('n');
      const notes = document.activeElement as HTMLTextAreaElement;
      expect(notes.tagName).toBe('TEXTAREA');
      fireEvent.change(notes, { target: { value: 'Wants a call back tomorrow morning.' } });

      // ── 11. Save, from outside the field the note was typed in ────────────────
      // `Esc` blurs without clearing, which is the position the page's own global
      // handler has to work from — `NotesField` owns the key while focus is inside
      // it, so submitting from in there cannot see the page binding at all.
      press('Escape', notes);
      expect(notes.value).toBe('Wants a call back tomorrow morning.');
      expect(document.activeElement).not.toBe(notes);
      const save = screen.getByRole('button', { name: /save & next call/i });
      expect(save.getAttribute('aria-disabled')).toBeNull();
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
      });
      await act(async () => {});

      expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
      expect(mocks.submitDisposition.mock.calls[0]![1]).toMatchObject({
        disposition_code: 'callback',
        notes: 'Wants a call back tomorrow morning.',
      });
      expect(mocks.submitDisposition.mock.calls[0]![1]).toHaveProperty('callback_at');

      // ── 12. Back to the pool ──────────────────────────────────────────────────
      await act(async () => {
        latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:05:40.000Z' });
      });
      expect(screen.getByTestId('band-title').textContent).toBe('Ready');

      // The criterion itself: the twelve steps above, and not one pointer event.
      expect(pointer.seen).toEqual([]);
    } finally {
      pointer.stop();
    }
  });
});

describe('criterion (c) — a required note blocks submission, and whitespace is not a note', () => {
  /** The keypath an agent takes: they are typing, so the key fires from the field. */
  function ctrlEnter(target: Element) {
    act(() => {
      fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true });
    });
  }

  it('refuses a whitespace-only note, then accepts the same field one character later', async () => {
    await onCall();
    // `2` is `callback`, the `requires_note` entry.
    press('2');
    const notes = document.activeElement as HTMLTextAreaElement;
    expect(notes.tagName).toBe('TEXTAREA');
    // On the call, the outcome is picked by its key and saved from the note; the Save button is
    // What happened?'s. The note card says what is missing.

    // Whitespace is exactly what an agent under time pressure types, and the API
    // rejects it with `note_required` — so the console must not let it through, or
    // the agent watches a submit "succeed" that the server refused.
    fireEvent.change(notes, { target: { value: '   \n\t ' } });

    expect(screen.getByTestId('note-needed').textContent).toBe('Write a note for this one.');
    ctrlEnter(notes);
    await act(async () => {});
    expect(mocks.submitDisposition).not.toHaveBeenCalled();

    /**
     * **The half that proves the negative above can fail.** One real character in
     * the same field, and every one of those three assertions flips: the reason
     * clears, the button enables, and the same keypress sends. Without this the
     * `not.toHaveBeenCalled()` would also pass against a console that can never
     * submit anything at all — which is precisely the defect that was here.
     */
    fireEvent.change(notes, { target: { value: 'Asked to be called back.' } });

    expect(screen.queryByTestId('note-needed')).toBeNull();
    ctrlEnter(notes);
    await act(async () => {});

    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
    expect(mocks.submitDisposition.mock.calls[0]![1]).toMatchObject({
      disposition_code: 'callback',
      notes: 'Asked to be called back.',
    });
  });

  it('sends the disposition ONCE for one Ctrl+Enter, though two handlers see the key', async () => {
    /**
     * `NotesField` owns `Ctrl+Enter` and calls `submit()`; the key then bubbles to
     * the page's `window` handler, which calls it again. `submitting` and
     * `dispositionSubmitted` are React state and neither is readable by the second
     * call in the same task, so both requests went out and the API recorded whichever
     * landed second against an attempt the first had already dispositioned.
     *
     * The count is the whole assertion. `toHaveBeenCalled()` passes at one and at
     * two, which is how this survived.
     */
    await onCall();
    press('2');
    const notes = document.activeElement as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: 'One note, one save.' } });

    ctrlEnter(notes);
    await act(async () => {});

    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── The wrap-up the API never announces ─────────────────────────────────────────
 *
 * `WrapupManager.enter` returns early when the attempt already carries a
 * `disposition_code` — the agent filled the form and *then* hung up, which is an
 * ordinary habit, not an edge case (a staging session was
 * dispositioned three seconds before the hangup). That return happens **after** the
 * state is written to Redis and **before** the `agent_state{wrapup}` and `wrapup`
 * frames are sent, so the console's whole account of the call ending is the
 * `released` frame, and the next thing it hears is `agent_state{available}`.
 *
 * The consequence is deliberate: the pad
 * re-locks and nothing sticks, but the release copy lives in the wrap-up rail, so on
 * this path "the panel simply empties instead of explaining itself". These drive that
 * exact frame sequence — nothing invented, nothing the API does not send.
 */
describe('a call whose wrap-up the API never announced', () => {
  const RELEASED = {
    event: 'released',
    attempt_id: 'att-1',
    reason: 'completed',
    requires_disposition: true,
    // `releaseMessageFor('completed')` on the server, exactly.
    message: 'Call ended.',
  };

  it('tells the agent the call ended rather than emptying the panel', async () => {
    await onCall();

    await act(async () => {
      latest().emit(RELEASED);
    });
    // The API's early return: NO `agent_state{wrapup}`, NO `wrapup` frame, straight
    // back to the pool.
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' });
    });

    // The account What happened? would have carried, as a banner on Ready, in the station's own
    // words (AS15: never the server's sentence).
    const notice = screen.getByTestId('unexplained-release');
    expect(notice.textContent).toBe('The last call ended.');
    expect(notice.textContent).not.toContain('Call ended.');
    expect(screen.getByTestId('band-title').textContent).toBe('Ready');
  });

  it('does not read as Offline in the window before the state frame lands', async () => {
    /**
     * Emitted on its own rather than batched with what follows, because that window
     * is the bug: `released` clears `live` while `agentState` is still `on_call`, and
     * in production the next frame is a separate socket message. Batched into one
     * `act` — as every other test in this file does — the intermediate render never
     * happens and the defect is invisible.
     */
    await onCall();

    await act(async () => {
      latest().emit(RELEASED);
    });

    expect(screen.getByTestId('band-title').textContent).not.toBe('Namaste, Asha');
    // What it says instead, named: the outcome is owed, so What happened?.
    expect(screen.getByTestId('band-title').textContent).toBe('What happened?');
  });

  it('says nothing extra once a real wrap-up has already explained the call', async () => {
    /**
     * The other half, and the reason the station clears `release` when a wrap-up
     * genuinely ends. A wrap-up that happened has had the release copy in the rail
     * for its whole window; repeating it in the idle panel afterwards would report a
     * finished call as if it had just happened — the stale-notice defect refused
     * everywhere else on this screen.
     */
    await onCall();
    await act(async () => {
      latest().emit(RELEASED);
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
      latest().emit({
        event: 'wrapup',
        wrapup: {
          attempt_id: 'att-1',
          ends_at: '2026-08-11T10:05:30.000Z',
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: true,
        },
      });
    });
    expect(screen.getByTestId('band-title').textContent).toBe('What happened?');

    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:05:40.000Z' });
    });

    expect(screen.queryByTestId('unexplained-release')).toBeNull();
    // Paired with the positive, so this is not an assertion satisfied by a screen that
    // renders nothing: Ready is what should be there instead.
    expect(screen.getByTestId('waiting-headline').textContent).toBe('Next call is coming…');
  });

  it('drops the account the moment the next customer arrives', async () => {
    // It was about someone else — the same rule the missed-release notice follows.
    await onCall();
    await act(async () => {
      latest().emit(RELEASED);
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' });
    });
    expect(screen.getByTestId('unexplained-release')).toBeTruthy();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });

    expect(screen.queryByTestId('unexplained-release')).toBeNull();
    // The new contact is on screen, so the screen is not merely blank.
    expect(within(screen.getByTestId('customer-card')).getByText(ATTEMPT.phone_e164)).toBeTruthy();
  });
});

describe('hang up actually hangs up', () => {
  /**
   * Nothing in this file exercised the hang-up action before — only its position
   * in tab order. That is how it shipped doing nothing: the page sent a station
   * socket frame no listener in the API reads, then called an HTTP route the API never
   * registered and **swallowed the 404**, on the reasoning that the frame had
   * already worked. Two dead paths, one silent catch, and a green suite.
   *
   * So these drive `E`,`E` — the real keypath — and assert the request and the
   * agent-visible consequence, never that a handler exists.
   */
  it('calls the HTTP route for the live attempt', async () => {
    mocks.hangupAttempt.mockResolvedValue(undefined);
    await onCall();

    press('e');
    press('e');

    expect(mocks.hangupAttempt).toHaveBeenCalledWith('att-1', 'tenant-1', 'account-1');
  });

  it('analytics: talk_seconds is measured on the corrected clock, as the rail’s timer is', async () => {
    /**
     * The rail's talk timer reads `bridged_at` through the offset-corrected clock;
     * the hang-up's `talk_seconds` read it against the raw client clock, so on a
     * machine 10s fast the event reported ten seconds the agent never talked.
     */
    analyticsMocks.trackAgencyHangupRequested.mockReset();
    mocks.hangupAttempt.mockResolvedValue(undefined);
    vi.useFakeTimers();
    const clientNow = Date.parse('2026-08-11T10:00:34.000Z');
    vi.setSystemTime(clientNow);
    await onCall();
    // A pong saying the server is 10s behind this client: offset −10s.
    await act(async () => {
      latest().emit({ event: 'pong', ts: clientNow, server_ts: clientNow - 10_000 });
    });

    press('e');
    press('e');

    // Bridged at 10:00:04 server time = 10:00:14 on this client: 20s, not 30s.
    expect(analyticsMocks.trackAgencyHangupRequested).toHaveBeenCalledWith(
      expect.objectContaining({ was_bridged: true, talk_seconds: 20 }),
    );
  });

  it('sends no socket frame — the console has exactly one hangup path', async () => {
    mocks.hangupAttempt.mockResolvedValue(undefined);
    await onCall();
    const before = latest().sent.length;

    press('e');
    press('e');

    // Asserting the count rather than "no frame with event: hangup": a second
    // path re-added under any other name would still be a second ownership check
    // to keep in step with the API's.
    expect(latest().sent).toHaveLength(before);
  });

  it('tells the agent they are still connected when the hangup fails', async () => {
    // The old catch discarded exactly this. An agent who pressed Hang up and was
    // told nothing has no way to know the customer can still hear them.
    mocks.hangupAttempt.mockRejectedValue(new Error('Service Unavailable'));
    await onCall();

    press('e');
    await act(async () => {});
    press('e');
    await act(async () => {});

    const notice = await screen.findByTestId('hangup-failure');
    expect(notice.textContent).toMatch(/You are still on the call/);
    // `role="alert"` is the load-bearing half — a polite region would let the
    // agent keep talking to a customer they think they hung up on.
    expect(notice.getAttribute('role')).toBe('alert');
  });

  it('retires the failure notice once the call it describes is over', async () => {
    // Every sentence the notice can say ends "you are still connected", which
    // stops being true the instant `released` lands. Left up, it would tell the
    // agent they are on a call that is over.
    mocks.hangupAttempt.mockRejectedValue(new Error('Service Unavailable'));
    await onCall();
    press('e');
    await act(async () => {});
    press('e');
    await act(async () => {});
    expect(await screen.findByTestId('hangup-failure')).toBeTruthy();

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'completed',
        requires_disposition: true,
        message: 'Call ended.',
      });
    });

    expect(screen.queryByTestId('hangup-failure')).toBeNull();
  });

  it('does not report a failed hangup over a call that has since moved on', async () => {
    // The rejection resolves after a new `reserved` may have landed. Reporting
    // the previous call's failure on the new one is the stale-response hazard
    // already refused for dispositions.
    let reject: (err: Error) => void = () => {};
    mocks.hangupAttempt.mockReturnValue(new Promise((_, r) => { reject = r; }));
    await onCall();

    press('e');
    press('e');

    await act(async () => {
      latest().emit({ event: 'released', attempt_id: 'att-1', reason: 'remote_hangup' });
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });
    await act(async () => {
      reject(new Error('Service Unavailable'));
    });

    expect(screen.queryByTestId('hangup-failure')).toBeNull();
  });
});

describe('the refusal that makes a disposition mandatory', () => {
  it('states the API 409 under the rail rather than swallowing it', async () => {
    // A real `ApiError` (`statusCode`/`details`), not a hand-built `{status, body}`
    // — the console read the latter, so this test used to pass against a shape
    // `apiFetch` cannot throw. See the same note in `useAgencyConsole.test.ts`.
    mocks.setAgentAvailable.mockRejectedValue(
      new ApiError(409, {
        error: 'Disposition Required',
        code: 'attempt_not_dispositionable',
        message: 'Submit a disposition for your last call before going available.',
      }),
    );
    await mounted();

    press('a');
    await act(async () => {});

    expect(screen.getByTestId('presence-refusal').textContent).toBe(
      'Save what happened on your last call first.',
    );
    // A banner under the band, never IN the band — the band is the agent's state.
    expect(screen.getByTestId('band-title').textContent).toBe('Namaste, Asha');
  });

  describe('a call that ended while the socket was away', () => {
    /**
     * `ready.missed_release` — and the API **consumes it on read**
     * (`takeMissedRelease` clears as it reads), so this frame is the only time the
     * console is ever offered it. Dropped, the record is gone for good: an agent
     * who loses their connection mid-call reconnects to an empty station with no
     * account of the call they were on, which reads as data loss because it is.
     */
    it('tells the agent what happened, prefixed so it cannot read as fresh news', async () => {
      await mounted();
      await act(async () => {
        latest().emit({
          event: 'ready',
          session_id: 'sess-1',
          state: 'available',
          missed_release: {
            attempt_id: 'att-1',
            reason: 'remote_hangup',
            requires_disposition: false,
            message: 'The customer hung up.',
            ended_at: '2026-08-11T10:04:00.000Z',
          },
        });
      });

      const notice = screen.getByTestId('missed-release');
      // The prefix is load-bearing: the agent has been watching the internet screen,
      // and an unprefixed "The customer hung up" reads as a call that just ended
      // rather than the one they were on. In the station's words, keyed on the reason.
      expect(notice.textContent).toBe('While your internet was down, the customer hung up.');
      expect(screen.queryByText('The customer hung up.')).toBeNull();
    });

    it('drops the notice the moment the next customer arrives', async () => {
      // It was about someone else. Left beside the new contact's details it is the
      // stale-notice defect the DNC and hang-up paths already refuse.
      await mounted();
      await act(async () => {
        latest().emit({
          event: 'ready',
          session_id: 'sess-1',
          state: 'available',
          missed_release: {
            attempt_id: 'att-1',
            reason: 'remote_hangup',
            requires_disposition: false,
            message: 'The customer hung up.',
            ended_at: '2026-08-11T10:04:00.000Z',
          },
        });
      });
      expect(screen.getByTestId('missed-release')).toBeTruthy();

      await act(async () => {
        latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
      });

      expect(screen.queryByTestId('missed-release')).toBeNull();
    });
  });

  describe('a break queued while the socket was away', () => {
    /**
     * **The pill had never been asserted on this page**, only in isolation — so the
     * one thing nobody had checked was whether the agent actually sees it. That
     * matters more here than for most surfaces: The API reports the queue with `peek`
     * and `releaseAgent` `take`s it when wrap-up ends, so **the break lands whether
     * or not this pill rendered**. An unrendered pill is not a missing reminder, it
     * is an agent dropped out of the pool with no warning and no chance to cancel.
     */
    const WRAPUP_ANCHOR = {
      attempt_id: 'att-1',
      ends_at: '2026-08-11T10:05:30.000Z',
      requires_disposition: true,
      disposition_submitted: false,
      auto_return: true,
    };

    /** A real drop and reconnect: same mount, second socket, re-minted token. */
    async function reconnected(): Promise<void> {
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
        expires_at: '2026-08-11T10:05:00.000Z',
      });
      const before = FakeSocket.instances.length;
      await act(async () => {
        latest().serverClose(1006, '');
      });
      // The backoff is the hook's own 500ms; this waits for the socket, not a delay.
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1), {
        timeout: 3000,
      });
      await act(async () => {
        latest().open();
      });
    }

    it('warns on the reconnect, and the ✕ cancels against the API rather than dismissing', async () => {
      const view = await onCall();
      await act(async () => {
        latest().emit({
          event: 'released',
          attempt_id: 'att-1',
          reason: 'remote_hangup',
          requires_disposition: true,
          message: 'The customer hung up.',
        });
      });
      // Nothing on screen about a break: this console never issued the request and
      // the frame that announced it went into the socket that has just died.
      expect(view.container.querySelector('[data-testid="queued-break"]')).toBeNull();

      await reconnected();
      await act(async () => {
        latest().emit({
          event: 'ready',
          session_id: 'sess-1',
          state: 'wrapup',
          active_wrapup: WRAPUP_ANCHOR,
          pending_state: 'break',
          pending_break_reason: 'lunch',
        });
      });

      const chip = screen.getByTestId('queued-break');
      // The catalog label, never the raw code — and the copy states what will
      // happen, not that a request was recorded.
      expect(chip.textContent).toContain('Lunch break after this call');

      // The ✕ is a real `POST /break/cancel`, not a local hide: the queue lives on
      // the API, so a console that merely stopped rendering the pill would leave the
      // agent believing they had taken the break back.
      mocks.cancelQueuedBreak.mockResolvedValue({
        session_id: 'sess-1',
        state: 'wrapup',
        since: '2026-08-11T10:05:20.000Z',
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel the break after this call' }));
      });
      expect(mocks.cancelQueuedBreak).toHaveBeenCalledWith('sess-1', 'tenant-1', 'account-1');
      expect(view.container.querySelector('[data-testid="queued-break"]')).toBeNull();
    });
  });
});

describe('a lost station leaves the console a way back, and nothing to type into', () => {
  /**
   * `StateRail`'s `onReconnect` is optional BY DESIGN — absent means the rail
   * states the problem and offers nothing, which is what shipped and was the
   * defect. So the whole affordance rests on one line in this page passing the
   * hook's `reconnect`, and that line had no coverage outside `StateRail`'s own
   * unit test: removing it restored an agent with no way back, with the full
   * suite green.
   *
   * Driven through a real `4409`, which the API only started sending in this same
   * change — so this is also the first coverage of the code path end to end.
   */
  it('offers the reclaim on 4409 and reconnects when it is pressed', async () => {
    mocks.mintStationToken.mockResolvedValue({
      session_id: 'sess-1',
      station_ws_url: '/proxy/agency/station/sess-1?token=RECLAIM',
      expires_at: 'x',
    });
    const view = await mounted();
    const before = FakeSocket.instances.length;

    await act(async () => {
      latest().onclose?.({ code: 4409, reason: 'superseded' });
    });

    // Screen 12, with its one way back.
    expect(screen.getByTestId('band-title').textContent).toBe('Your work is open on another device');
    const button = screen.getByRole('button', { name: /use this computer/i });
    await act(async () => {
      button.click();
    });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1));
    expect(latest().url).toContain('token=RECLAIM');

    view.unmount();
  });

  it('leaves the disposition pad usable when the station merely disconnected', async () => {
    /**
     * The other side of the lock above, and the distinction is the whole point:
     * `superseded` means another window holds this session and has its own pad, so
     * our write could land and race theirs. `disconnected` means our socket died
     * and NOTHING replaced it — there is no rival pad, the disposition and notes
     * routes are HTTP and still work, and the agent may be mid-wrap-up with a
     * countdown running.
     *
     * Folding all three terminal states into one predicate locked this case too,
     * which put the only artefact of the call behind a control disabled for a
     * reason that does not apply, and made submitting a REQUIRED disposition
     * conditional on reconnecting inside a time-limited window.
     *
     * Reachable in the ordinary course rather than as a corner: the heartbeat hold
     * defers its give-up until `released` clears the live attempt, so this state
     * arrives at the start of wrap-up more often than at any other moment.
     */
    vi.useFakeTimers();
    try {
      const view = await onCall();
      const notes = () => view.container.querySelector('textarea');
      expect(notes()?.disabled).toBe(false);

      await act(async () => {
        latest().emit({
          event: 'released',
          attempt_id: 'att-1',
          reason: 'remote_hangup',
          requires_disposition: true,
        });
      });

      // No pong, so the heartbeat gives up — with no second window anywhere.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      // What happened? stays, with the internet banner and its way back.
      expect(screen.getByTestId('band-title').textContent).toBe('What happened?');
      expect(screen.getByTestId('happened-internet')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again now' })).toBeTruthy();

      expect(notes()?.disabled).toBe(false);

      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks the disposition pad on a station that is gone', async () => {
    /**
     * The stated reason for making the losing console inert: *"so there is
     * no chance of the agent typing a note into a dead tab."* Both the
     * disposition and the notes route are HTTP, so a write from the dead tab may
     * actually LAND — racing the winning window's own pad — which is worse than
     * losing it. `live` is cleared only by `released`, which a terminal close
     * never delivers, so nothing else was locking it.
     */
    const view = await onCall();
    const notes = () => view.container.querySelector('textarea');
    // Enabled on a live call — the discriminator, so the assertion below cannot
    // pass against a pad that was disabled all along.
    expect(notes()?.disabled).toBe(false);

    await act(async () => {
      latest().onclose?.({ code: 4409, reason: 'superseded' });
    });

    // Screen 12 replaces the call: there is no note field to type into at all.
    expect(screen.getByTestId('band-title').textContent).toBe('Your work is open on another device');
    expect(notes()).toBeNull();

    view.unmount();
  });
});

/**
 * The bootstrap's
 * `intervals.deferred_hangup_ms` reaches the rail, so an agent whose socket drops
 * mid-call is told how long the call is held — as a bound, not a countdown.
 */
describe('the reconnect window, on the page (10 Call problem)', () => {
  it('tells an agent on a call how long the call is kept while the station reconnects', async () => {
    mocks.createAgencySession.mockResolvedValue({
      ...BOOTSTRAP,
      intervals: { ...BOOTSTRAP.intervals, deferred_hangup_ms: 30_000 },
    });
    await onCall();
    await act(async () => {
      latest().serverClose(1006, '');
    });
    await waitFor(() => expect(screen.getByTestId('band-title').textContent).toBe('Call problem'));
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Stay here. We are joining the call again.');
    // The bootstrap's window, counted down from the drop.
    expect(screen.getByTestId('call-kept').textContent).toMatch(/Call is kept for0:(30|29|28)/);
    // The customer card stays, and Try again now is the one action.
    expect(screen.getByTestId('customer-card')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again now/i })).toBeTruthy();
  });

  it('09 counts down to the next try when the agent is not on a call, and R tries now', async () => {
    mocks.mintStationToken.mockResolvedValue({ session_id: 'sess-1', station_ws_url: '/proxy/agency/station/sess-1?token=R', expires_at: 'x' });
    await mounted();
    await act(async () => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T09:59:00.000Z' });
    });
    const before = FakeSocket.instances.length;
    await act(async () => {
      latest().serverClose(1006, '');
    });
    expect(screen.getByTestId('band-title').textContent).toBe('Internet problem');
    expect(screen.getByTestId('retry-countdown').textContent).toContain('Trying again in');
    // With no internet the press cannot reach anyone: step 3 says to call the supervisor over.
    expect(screen.getByText('Still not working? Call your supervisor to your desk.')).toBeTruthy();
    press('r');
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(before));
  });
});
