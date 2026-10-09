import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StateRail, describeRail } from '../../components/agency/StateRail';
import type { ServerClock } from '../../hooks/useServerClock';
import type { LiveAttempt } from '../../hooks/useAgencyStation';
import type { WrapupAnchor } from '../../utils/agencyWrapup';
import type {
  AgencyAgentState,
  AgencyReservedAttempt,
  AgencyStationReleasedFrame,
} from '../../types/agency';

/**
 * The State Rail's "single most important component in the product", and
 *'s frame bindings at the point they are **consumed**.
 *
 * The rail's own rule is what most of this file protects: **the rail is the call's
 * state, and only an authoritative frame moves it.** Two Phase 2 additions push
 * against that from opposite directions and both are tested here rather than in
 * the hook, because the hook can only supply a value — whether it lands in the
 * label (a state claim) or the sub-text (a note about it) is decided here:
 *
 *  - the "no `agent_state` follows" line, which must NOT read as a state;
 *  - a wrap-up with no frame behind it, which must render no clock at all rather
 *    than an empty track that will never move.
 */

const BRIDGED_AT = '2026-08-11T10:00:04.000Z';
const T0 = Date.parse(BRIDGED_AT);

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
};

const liveBridged: LiveAttempt = {
  attempt: ATTEMPT,
  bridgedAt: BRIDGED_AT,
};

// `bridgedAt: null` IS "still ringing" — the rail has always derived it that way,
// and it is now the only discriminator `LiveAttempt` carries. The dead
// `secondsRemaining`/`ringing` fields that used to sit here came from a
// `countdown` frame the server emits from nowhere.
const liveRinging: LiveAttempt = {
  attempt: ATTEMPT,
  bridgedAt: null,
};

const RELEASE: AgencyStationReleasedFrame = {
  event: 'released',
  attempt_id: 'att-1',
  reason: 'remote_hangup',
  requires_disposition: true,
  message: 'Call ended.',
};

const TIMED_WRAPUP: WrapupAnchor = {
  attemptId: 'att-1',
  deadlineMs: T0 + 30_000,
  totalMs: 30_000,
  requiresDisposition: true,
  heldReason: null,
  autoReturn: true,
};

const WAITING = 'Saved — waiting for the dialer to move you on';

/**
 * A real `ServerClock`, offset zero. Not a partial cast: the rail reads `since`
 * for the talk timer and hands `now` to `WrapupTimer`, so a stub missing a member
 * would compile only behind an `as` and then throw or silently skip at the point
 * the timer is asserted.
 */
function clockAt(now: number): ServerClock {
  const parse = (v: string | number | null | undefined) =>
    v === null || v === undefined ? null : typeof v === 'number' ? v : Date.parse(v);
  return {
    now,
    offsetMs: 0,
    corrected: parse,
    since: (a) => {
      const t = parse(a);
      return t === null ? null : Math.max(0, now - t);
    },
    until: (d) => {
      const t = parse(d);
      return t === null ? null : Math.max(0, t - now);
    },
  };
}

function railBase(overrides: Partial<Parameters<typeof describeRail>[0]> = {}) {
  return {
    agentState: 'wrapup' as const,
    connection: 'open' as const,
    live: null,
    release: RELEASE,
    wrapup: TIMED_WRAPUP,
    dialing: true,
    breakReasonLabel: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 12_000);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('describeRail — the waiting line is a note, not a state', () => {
  it('puts line in the sub-text and leaves the state label alone', () => {
    const withoutLine = describeRail(railBase());
    const withLine = describeRail(railBase({ waitingForDialer: WAITING }));

    /**
     * The load-bearing half. Rendering the copy as the **label** would assert a
     * transition no authority delivered — the agent is still in wrap-up, and
     * `agent_state` is the only thing that may say otherwise. An
     * implementation that swaps the label passes any assertion that merely looks
     * for the string somewhere in the rail, which is why this names the slot.
     */
    expect(withLine.label).toBe(withoutLine.label);
    expect(withLine.detail).toBe(WAITING);
    // Still wrap-up's colour. A saved disposition waiting on the dialer is not an
    // error, so it must not recruit the danger treatment.
    expect(withLine.tone).toBe('warning');
  });

  it('is outranked by a live call — a mid-call submit must not overwrite "On call"', () => {
    // The pad allows a submit while the call is up, so this pairing is reachable:
    // the line exists but the rail is describing a customer who is still talking.
    const rail = describeRail(
      railBase({ agentState: 'on_call', live: liveBridged, waitingForDialer: WAITING }),
    );

    expect(rail.label).toBe('On call');
    expect(rail.detail).toBe(ATTEMPT.phone_e164);
  });

  it('is outranked by a lost socket', () => {
    const rail = describeRail(railBase({ connection: 'reconnecting', waitingForDialer: WAITING }));

    // An agent whose socket is gone must not be told they are waiting on the
    // dialer — they are waiting on the connection, and that is actionable.
    expect(rail.label).toBe('Reconnecting');
    expect(rail.detail).not.toBe(WAITING);
  });

  it('falls back to the release reason when there is no line', () => {
    // Proves the slot is shared rather than reserved: the sub-text is what
    // occupies it normally, so a test asserting only the waiting case could not
    // tell "always the line" from "the line when present".
    expect(describeRail(railBase()).detail).not.toBeNull();
  });
});

describe('StateRail — what reaches the DOM', () => {
  function renderRail(props: Partial<Parameters<typeof StateRail>[0]> = {}) {
    return render(
      <StateRail
        agentState="wrapup"
        agentStateSince="2026-08-11T10:05:00.000Z"
        breakReasonLabel={null}
        connection="open"
        live={null}
        release={RELEASE}
        wrapup={TIMED_WRAPUP}
        dispositionSubmitted={false}
        dialing
        clock={clockAt(T0 + 12_000)}
        presenceBusy={false}
        onGoAvailable={() => {}}
        onEndBreak={() => {}}
        {...props}
      />,
    );
  }

  it('renders the waiting line as the rail sub-text, with the tone unchanged', () => {
    renderRail({ waitingForDialer: WAITING });

    expect(screen.getByTestId('rail-detail').textContent).toBe(WAITING);
    expect(screen.getByTestId('rail-label').textContent).not.toBe(WAITING);
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('warning');
  });

  it('renders no clock, and no empty track, when no wrap-up frame arrived', () => {
    /**
     *'s "no wrap-up frame at all" row at the point of consumption: the
     * state is `wrapup`, the anchor is null, and the rail must show "Wrap-up" with
     * **no bar, no digits and no waiting treatment**. `WrapupTimer` has its own
     * tests for the held panel, but nothing there can see the rail rendering it
     * unconditionally — and a track that will never move is exactly the
     * forever-empty progress indicator forbids.
     */
    renderRail({ wrapup: null });

    // The words still come from the reason mapping, because a `released`
    // did arrive — it is the wrap-up *frame* that did not. Asserted rather than
    // assumed: an earlier draft of this test expected a bare "Wrap-up" plus a null
    // sub-text here, and was wrong about the product, not the other way round.
    expect(screen.getByTestId('rail-label').textContent).toBe('Wrap-up');
    expect(screen.getByTestId('rail-detail').textContent).toBe('The customer hung up.');
    expect(screen.queryByTestId('wrapup-track')).toBeNull();
    expect(screen.queryByTestId('wrapup-digits')).toBeNull();
    expect(screen.queryByTestId('wrapup-held-reason')).toBeNull();

    cleanup();

    // With no release either, "Wrap-up" is the fallback, with nothing to say about
    // why — and still no clock.
    renderRail({ wrapup: null, release: null });
    expect(screen.getByTestId('rail-label').textContent).toBe('Wrap-up');
    expect(screen.queryByTestId('rail-detail')).toBeNull();
    expect(screen.queryByTestId('wrapup-track')).toBeNull();
  });

  /**
   * ── Criterion (b)'s last unasserted hop ──────────────────────────────────────
   *
   * `agencyWrapup.test.ts` pins the arithmetic (a pure function of the anchor and
   * `now`, with nothing accumulating) and `WrapupTimer.test.tsx` pins the component
   * (it follows `ends_at` even when `since + wrapup_seconds` disagrees, and applies
   * the offset). Neither can see **what the rail hands the component as `now`**, and
   * that is the hop the criterion lives or dies on: `useServerClock` re-reads
   * `Date.now()` every repaint precisely so no consumer holds a decrementing value,
   * and a rail that passed anything else — a captured instant, the anchor's own
   * deadline — would render a countdown that never moves while every test above
   * stayed green. Verified: replacing `now={clock.now}` with `now={deadlineMs}` left
   * all 5167 tests in this repo passing.
   *
   * 12s into a 30s window is a value only a rail that passed the corrected present
   * through can produce; a frozen one reads `0:30` (captured at open) or `0:00` (the
   * deadline), and neither is 18.
   */
  it('hands the wrap-up timer the corrected present, not a captured or derived instant', () => {
    renderRail({ clock: clockAt(T0 + 12_000) });
    expect(screen.getByTestId('wrapup-digits').textContent).toBe('0:18');

    cleanup();

    // And it keeps handing it the *present*: 8 seconds later the same anchor reads 8
    // seconds lower, which is the property "does not drift over a shift" is made of.
    renderRail({ clock: clockAt(T0 + 20_000) });
    expect(screen.getByTestId('wrapup-digits').textContent).toBe('0:10');
  });

  it('anchors the talk timer to bridged_at, and shows none while still ringing', () => {
    // 12s after the server's bridge instant, through the corrected clock — not a
    // restart at 00:00 and not client receipt time.
    renderRail({ agentState: 'on_call', live: liveBridged, release: null, wrapup: null });
    expect(screen.getByTestId('talk-timer').textContent).toBe('0:12');

    cleanup();

    // `bridgedAt` null means the customer has not answered, so there is nothing to
    // anchor to and a timer would be counting something that has not started.
    renderRail({ agentState: 'reserved', live: liveRinging, release: null, wrapup: null });
    expect(screen.queryByTestId('talk-timer')).toBeNull();
  });

  /**
   * ── The state-rail distinctness requirement, as an injectivity property ────────────────────
   *
   * "Every agent state has an unambiguous visual treatment" is not the same claim as
   * "every agent state renders something", and the gap between them is where this
   * criterion actually fails: two states quietly sharing one treatment passes every
   * per-state assertion in this file, because each of them individually renders a
   * tone, a label and a hatch attribute exactly as expected.
   *
   * So the six states are rendered together and their treatments compared **against
   * each other**. The triple is `(data-tone, data-hatched, label)` — the three
   * channels the rail actually paints, 's rule that colour never carries
   * state alone — read off the DOM rather than from `describeRail`, because
   * `data-hatched` is the component's and not the table's.
   *
   * Two collisions are live in this table and both are load-bearing:
   *  - `offline` and `break` share `neutral` ( gives both `--bg-tertiary`), so the
   *    hatch is the only tint-independent separator;
   *  - `reserved` and `wrapup` share `warning`, so the label is.
   * Each is asserted explicitly below, so removing either second channel reddens a
   * test that names the pair rather than only shrinking a set.
   */
  describe('criterion (a) — the six states are told apart from each other', () => {
    /** Each state in the shape the frames actually deliver it. */
    const STATES: { state: AgencyAgentState; props: Partial<Parameters<typeof StateRail>[0]> }[] = [
      { state: 'offline', props: { agentState: 'offline', live: null, release: null, wrapup: null } },
      {
        state: 'available',
        props: { agentState: 'available', live: null, release: null, wrapup: null, dialing: true },
      },
      // `reserved` arrives with an unanswered attempt; `bridgedAt: null` IS "ringing".
      {
        state: 'reserved',
        props: { agentState: 'reserved', live: liveRinging, release: null, wrapup: null },
      },
      {
        state: 'on_call',
        props: { agentState: 'on_call', live: liveBridged, release: null, wrapup: null },
      },
      // Wrap-up with the frame behind it, which is the only way it is reached.
      {
        state: 'wrapup',
        props: { agentState: 'wrapup', live: null, release: RELEASE, wrapup: TIMED_WRAPUP },
      },
      {
        state: 'break',
        props: {
          agentState: 'break',
          breakReasonLabel: 'Lunch',
          live: null,
          release: null,
          wrapup: null,
        },
      },
    ];

    /** `(tone, hatched, label)` — everything the rail paints to say which state it is. */
    function treatmentOf(props: Partial<Parameters<typeof StateRail>[0]>) {
      renderRail(props);
      const rail = screen.getByRole('status');
      const treatment = {
        tone: rail.getAttribute('data-tone'),
        hatched: rail.getAttribute('data-hatched'),
        label: screen.getByTestId('rail-label').textContent,
      };
      cleanup();
      return treatment;
    }

    it('gives all six a treatment no other state can produce', () => {
      const treatments = STATES.map(({ state, props }) => ({ state, ...treatmentOf(props) }));

      // Every state says something. Necessary but nowhere near sufficient — this is
      // the assertion that a shared treatment passes.
      for (const t of treatments) {
        expect(t.tone, `${t.state} has no tone`).toBeTruthy();
        expect(t.label, `${t.state} has no label`).toBeTruthy();
      }

      // The property the criterion is actually about: the map from state to
      // treatment is injective. A pair that collapses shows up here as a set of
      // five, and the message names which pair.
      const keys = treatments.map((t) => `${t.tone}|${t.hatched ?? '-'}|${t.label}`);
      const collisions = keys
        .map((key, i) => ({ key, state: treatments[i]!.state }))
        .filter((entry, _i, all) => all.filter((other) => other.key === entry.key).length > 1)
        .map((entry) => `${entry.state} → ${entry.key}`);
      expect(collisions, 'two agent states share one visual treatment').toEqual([]);
      expect(new Set(keys).size).toBe(STATES.length);
    });

    it('separates the two states that share a tint by the hatch, not by colour', () => {
      const offline = treatmentOf({ agentState: 'offline', live: null, release: null, wrapup: null });
      const onBreak = treatmentOf({
        agentState: 'break',
        breakReasonLabel: 'Lunch',
        live: null,
        release: null,
        wrapup: null,
      });

      // The collision is real and intended ('s table), which is what makes the
      // second channel load-bearing rather than decorative.
      expect(onBreak.tone).toBe(offline.tone);
      expect(onBreak.hatched).toBe('true');
      expect(offline.hatched).toBeNull();
      expect(onBreak.label).not.toBe(offline.label);
    });

    it('separates the two states that share the warning tone by the label', () => {
      const reserved = treatmentOf({
        agentState: 'reserved',
        live: liveRinging,
        release: null,
        wrapup: null,
      });
      const wrapup = treatmentOf({
        agentState: 'wrapup',
        live: null,
        release: RELEASE,
        wrapup: TIMED_WRAPUP,
      });

      expect(wrapup.tone).toBe(reserved.tone);
      expect(wrapup.label).not.toBe(reserved.label);
      // Neither is hatched, so the label is the ONLY separator here — asserted so a
      // change that made the two labels agree cannot be waved through as "the tone
      // still differs".
      expect(reserved.hatched).toBeNull();
      expect(wrapup.hatched).toBeNull();
    });

    /**
     * The window this criterion actually lost, and the one the enumeration above
     * cannot see: `released` clears `live` and the server's *next* frame is what says
     * whether a wrap-up follows, so between the two `agentState` is still `on_call`
     * with nothing live behind it. That fell through to the `Offline` fallback — an
     * agent who had just finished talking to a customer told they had not started
     * their shift, in the one region calls the most important on the screen.
     */
    it('never reads as Offline in the window between `released` and the next state frame', () => {
      renderRail({ agentState: 'on_call', live: null, release: RELEASE, wrapup: null });

      // Positively identified, not merely "not Offline": the release copy is
      // something only a rail that consulted the frame can produce, so this cannot
      // be satisfied by the rail rendering nothing.
      expect(screen.getByTestId('rail-label').textContent).toBe('Wrap-up');
      expect(screen.getByTestId('rail-detail').textContent).toBe('The customer hung up.');
      expect(screen.getByRole('status').getAttribute('data-tone')).toBe('warning');

      cleanup();

      // And with no release either — a `ready` reporting `on_call` with no attempt —
      // it is still the server's word for the state and still not `Offline`.
      renderRail({ agentState: 'on_call', live: null, release: null, wrapup: null });
      expect(screen.getByTestId('rail-label').textContent).toBe('On call');
    });
  });

  it('hatches the break state, since break and offline share a tint', () => {
    renderRail({
      agentState: 'break',
      breakReasonLabel: 'Lunch',
      release: null,
      wrapup: null,
    });
    const rail = screen.getByRole('status');

    // A second channel, not a decoration: colour alone cannot separate "I have
    // stepped away" from "I have not started".
    expect(rail.getAttribute('data-hatched')).toBe('true');
    expect(screen.getByTestId('rail-label').textContent).toBe('On break — Lunch');

    cleanup();
    renderRail({ agentState: 'offline', release: null, wrapup: null });
    expect(screen.getByRole('status').getAttribute('data-hatched')).toBeNull();
  });
  /**
   *'s third row and's reclaim — the two states an agent can act
   * their way out of, and the two that shipped as copy with no control at all.
   *
   * That absence is the reason the server's `4409` could not safely be sent: the console
   * would set `superseded`, release the microphone, render "Your station moved to
   * another window" and offer nothing, so the only recovery was a page reload.
   */
  describe('the way back out of a lost station', () => {
    it('states the disconnected case in’s words, in the danger tone', () => {
      renderRail({ connection: 'disconnected' });
      expect(screen.getByTestId('rail-label').textContent).toBe(
        'Disconnected — you are not receiving calls',
      );
      expect(screen.getByRole('status').getAttribute('data-tone')).toBe('danger');
    });

    it('offers Reconnect when disconnected', () => {
      const onReconnect = vi.fn();
      renderRail({ connection: 'disconnected', onReconnect });
      screen.getByRole('button', { name: 'Reconnect' }).click();
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('words the same handler as a reclaim when another window took the station', () => {
      // One act — reclaiming IS attaching, because the server gives the station to
      // whoever attaches last — but the agent's question is different, so the
      // label is too.
      const onReconnect = vi.fn();
      renderRail({ connection: 'superseded', onReconnect });
      screen.getByRole('button', { name: 'Use this window instead' }).click();
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('offers nothing while the console is still retrying by itself', () => {
      // A button that races the hook's own pending retry is worse than none.
      renderRail({ connection: 'reconnecting', onReconnect: vi.fn() });
      expect(screen.queryByRole('button', { name: /Reconnect|Use this window/ })).toBeNull();
    });

    it('offers nothing when the session itself is gone', () => {
      // Reconnecting cannot help — the session is over, and the rail already says
      // to rejoin the campaign.
      renderRail({ connection: 'session_gone', onReconnect: vi.fn() });
      expect(screen.queryByRole('button', { name: /Reconnect|Use this window/ })).toBeNull();
    });

    it('does not tell an agent to wait beside a button that says otherwise', () => {
      // "Waiting for the station connection…" is false once the console has
      // stopped, and it used to render on every non-open connection.
      renderRail({ connection: 'disconnected', agentState: 'offline', release: null, wrapup: null, onReconnect: vi.fn() });
      expect(screen.queryByText('Waiting for the station connection…')).toBeNull();
    });
    it('speaks about the CALL, not the queue, when the connection dies mid-call', () => {
      /**
       * The `disconnected` arm outranks the live-attempt arms, so an agent four
       * minutes into a conversation was told "you are not receiving calls" —
       *'s copy, written for an idle agent — while a talk timer counted up
       * beside it. owns the words for losing the connection during a call.
       */
      renderRail({ connection: 'disconnected', live: liveBridged, release: null, wrapup: null });
      expect(screen.getByTestId('rail-label').textContent).toBe('Connection lost');
      expect(screen.getByTestId('rail-detail').textContent).toContain('can’t hear you');
    });

    it('stops the talk timer on the states where the call is unreachable', () => {
      // The timer is independent of `connection`, so it kept counting beside
      // copy asserting the opposite. Two contradictory claims in the same 64px.
      for (const connection of ['disconnected', 'superseded', 'session_gone'] as const) {
        cleanup();
        renderRail({ connection, live: liveBridged, release: null, wrapup: null });
        expect(screen.queryByTestId('talk-timer')).toBeNull();
      }
    });

    it('keeps the talk timer through a reconnect, which the call may survive', () => {
      // The deliberate exception: `sendMedia` reads the socket ref at send time,
      // so a blip is the case the uplink is built to survive. Stopping the clock
      // would tell the agent the call had ended.
      renderRail({ connection: 'reconnecting', live: liveBridged, release: null, wrapup: null });
      expect(screen.queryByTestId('talk-timer')).not.toBeNull();
    });

    it('tells the agent it is two steps, because it is two steps', () => {
      // The server released the agent when the socket went, so `ready` reports them
      // `offline` after a successful reconnect. "Reconnect to start taking calls
      // again" promised one press and left agents out of the pool.
      renderRail({ connection: 'disconnected' });
      expect(screen.getByTestId('rail-detail').textContent).toBe(
        'Reconnect, then go available to start taking calls.',
      );
    });
  });
});

/**
 * The server's `intervals.deferred_hangup_ms`, rendered as an upper bound while a live call is
 * reconnecting — never a countdown (see the `disconnected` arm's note).
 */
describe('the reconnect window', () => {
  it('states the window as an upper bound while a call is reconnecting', () => {
    const rail = describeRail(
      railBase({ connection: 'reconnecting', live: liveBridged, release: null, wrapup: null, deferredHangupMs: 30_000 }),
    );
    expect(rail.detail).toBe(
      'Stay on the line — we’re reconnecting you. Your call is held for up to 30 seconds.',
    );
    expect(rail.detail).not.toMatch(/\d+s left|remaining/);
  });

  it('keeps the plain sentence with no call, or without the value', () => {
    const plain = 'Stay on the line — we’re reconnecting you.';
    expect(
      describeRail(railBase({ connection: 'reconnecting', live: null, release: null, wrapup: null, deferredHangupMs: 30_000 })).detail,
    ).toBe(plain);
    expect(
      describeRail(railBase({ connection: 'reconnecting', live: liveBridged, release: null, wrapup: null })).detail,
    ).toBe(plain);
  });
});
