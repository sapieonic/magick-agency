import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CampaignBehaviourSection } from '../../pages/campaigns/agency/CampaignBehaviourSection';
import { AbandonmentMeter } from '../../components/agency/AbandonmentMeter';
import {
  configFromCampaign,
  validateConfig,
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import type { AgencyCampaign } from '../../types/agency-campaign';
import { assertFieldAnnouncesError } from '../helpers/a11y';

/**
 * The abandonment limit as the supervisor meets it: the meter whose line is the
 * slider, and the number box beside it, inside the Behaviour section. The
 * rounding and the bounds are the pure module's (`utils/abandonmentCeiling.test.ts`);
 * these show that the drag, each key and the typed value reach them, and that the
 * two controls stay one value.
 */

afterEach(cleanup);

/**
 * The section's behaviour group. Without `fieldErrors`, the page's own validator
 * feeds its errors live; with them (`{}` included), as the builder and settings
 * pages drive it, where they stay as the last save left them.
 */
function Harness({
  campaign,
  readOnly,
  fieldErrors,
}: {
  campaign?: Partial<AgencyCampaign>;
  readOnly?: boolean;
  fieldErrors?: Record<string, string>;
}) {
  const [state, setState] = useState<CampaignConfigState>(() =>
    configFromCampaign({ id: 'camp-1', name: 'Collections', status: 'draft', ...campaign }),
  );
  return (
    <>
      <CampaignBehaviourSection
        state={state}
        onChange={setState}
        fieldErrors={fieldErrors ?? validateConfig(state)}
        layout="plain"
        include={['behaviour']}
        readOnly={readOnly}
      />
      <output data-testid="state-ceiling">{String(state.abandonmentCeilingPct)}</output>
    </>
  );
}

const slider = () => screen.getByRole('slider', { name: 'Abandonment limit' });
const input = () => screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement;
const stateValue = () => screen.getByTestId('state-ceiling').textContent;
const lineLeft = () => (screen.getByTestId('abandonment-meter-ceiling') as HTMLElement).style.left;
/** The ids an element's `aria-describedby` names. */
const describedIds = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
/** The text of everything an element's `aria-describedby` names, one entry per id. */
const describedTexts = (el: Element) => describedIds(el).map((id) => document.getElementById(id)?.textContent ?? '');
const LEAD_START = 'The campaign pauses itself when more than';
const RANGE_ERROR = 'Set the limit between 0.5% and 10%.';

/** Lay the track out at 200px wide from x = 100, so x = 100 + 20·p is p% on the scale. */
function layOutTrack() {
  const track = screen.getByTestId('abandonment-meter-ceiling').parentElement as HTMLElement;
  track.getBoundingClientRect = () =>
    ({ left: 100, right: 300, width: 200, top: 0, bottom: 8, height: 8, x: 100, y: 0, toJSON: () => ({}) }) as DOMRect;
  return track.parentElement as HTMLElement; // the hit area, which takes the pointer
}

describe('a new campaign', () => {
  it('starts at 3%, with the slider saying so', () => {
    render(<Harness />);
    expect(input().value).toBe('3');
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('3%');
    expect(lineLeft()).toBe('30%');

    const s = slider();
    expect(s.getAttribute('tabindex')).toBe('0');
    expect(s.getAttribute('aria-valuemin')).toBe('0.5');
    expect(s.getAttribute('aria-valuemax')).toBe('10');
    expect(s.getAttribute('aria-valuenow')).toBe('3');
    expect(s.getAttribute('aria-valuetext')).toBe(
      '3%: the campaign pauses when more than 3% of answered calls are abandoned',
    );
    expect(screen.getByTestId('abandonment-ceiling-lead').textContent).toContain(
      'more than 3% of the calls answered in the last 24 hours were abandoned',
    );
    expect(screen.getByTestId('abandonment-ceiling-hint').textContent).toContain('The default is 3%.');
  });
});

describe('the keyboard', () => {
  it('moves the line a tenth on the arrows, a percent on the Page keys, and to the ends on Home and End', () => {
    render(<Harness />);
    const steps: [string, string][] = [
      ['ArrowRight', '3.1'],
      ['ArrowUp', '3.2'],
      ['ArrowLeft', '3.1'],
      ['ArrowDown', '3'],
      ['PageUp', '4'],
      ['PageDown', '3'],
      ['End', '10'],
      ['Home', '0.5'],
    ];
    for (const [key, expected] of steps) {
      fireEvent.keyDown(slider(), { key });
      expect(slider().getAttribute('aria-valuenow'), key).toBe(expected);
      // The box follows the slider.
      expect(input().value, key).toBe(expected);
    }
    expect(lineLeft()).toBe('5%');
  });

  it('takes the keys it handles from the page, and only those', () => {
    render(<Harness />);
    // `fireEvent` returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(slider(), { key: 'PageUp' })).toBe(false);
    expect(fireEvent.keyDown(slider(), { key: 'Tab' })).toBe(true);
    expect(stateValue()).toBe('4');
  });
});

describe('the pointer', () => {
  it('jumps the line to where the track is pressed, then follows the drag', () => {
    render(<Harness />);
    const hit = layOutTrack();

    fireEvent.pointerDown(hit, { clientX: 190, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(stateValue()).toBe('4.5');
    expect(input().value).toBe('4.5');
    expect(lineLeft()).toBe('45%');
    // The press hands the slider focus, so the keys carry on from where the drag left it.
    expect(document.activeElement).toBe(slider());

    fireEvent.pointerMove(hit, { clientX: 152, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('2.6');

    // Past either end of the track the line holds at the bound.
    fireEvent.pointerMove(hit, { clientX: 900, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('10');
    fireEvent.pointerMove(hit, { clientX: -50, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('0.5');

    fireEvent.pointerUp(hit, { clientX: -50, pointerId: 1, pointerType: 'mouse' });
    // Released: a move no longer drags.
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('0.5');
  });

  it('belongs to the pointer that started it: a second pointer neither moves the line nor ends the drag', () => {
    render(<Harness />);
    const hit = layOutTrack();

    fireEvent.pointerDown(hit, { clientX: 190, pointerId: 1, pointerType: 'touch', button: 0 });
    expect(stateValue()).toBe('4.5');

    // A second finger lands, moves and lifts: none of it is the drag.
    fireEvent.pointerDown(hit, { clientX: 280, pointerId: 2, pointerType: 'touch', button: 0 });
    expect(stateValue()).toBe('4.5');
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 2, pointerType: 'touch' });
    expect(stateValue()).toBe('4.5');
    fireEvent.pointerUp(hit, { clientX: 260, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerCancel(hit, { clientX: 260, pointerId: 2, pointerType: 'touch' });

    // The first finger is still dragging.
    fireEvent.pointerMove(hit, { clientX: 152, pointerId: 1, pointerType: 'touch' });
    expect(stateValue()).toBe('2.6');
    fireEvent.pointerUp(hit, { clientX: 152, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerMove(hit, { clientX: 200, pointerId: 1, pointerType: 'touch' });
    expect(stateValue()).toBe('2.6');
  });

  it('ends the drag when the pointer capture is lost', () => {
    render(<Harness />);
    const hit = layOutTrack();

    fireEvent.pointerDown(hit, { clientX: 190, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(screen.getByTestId('abandonment-meter').getAttribute('data-dragging')).toBe('true');
    // Another pointer's capture is not this drag's.
    fireEvent.lostPointerCapture(hit, { pointerId: 2, pointerType: 'mouse' });
    fireEvent.pointerMove(hit, { clientX: 152, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('2.6');

    fireEvent.lostPointerCapture(hit, { pointerId: 1, pointerType: 'mouse' });
    expect(screen.getByTestId('abandonment-meter').getAttribute('data-dragging')).toBeNull();
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(stateValue()).toBe('2.6');
  });

  it('ignores a mouse move with no button held, as after a release the page never heard', () => {
    render(<Harness />);
    const hit = layOutTrack();
    fireEvent.pointerDown(hit, { clientX: 190, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse', buttons: 0 });
    expect(stateValue()).toBe('4.5');
  });

  it('ignores a move with no press, and a right-click', () => {
    render(<Harness />);
    const hit = layOutTrack();
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerDown(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse', button: 2 });
    expect(stateValue()).toBe('3');
  });

  it('does nothing while the track has no width, rather than jumping to an end', () => {
    render(<Harness />);
    // happy-dom lays nothing out: every rect is zero-sized.
    const hit = (slider().parentElement as HTMLElement).parentElement as HTMLElement;
    fireEvent.pointerDown(hit, { clientX: 190, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(stateValue()).toBe('3');
  });
});

describe('the number box', () => {
  it('moves the line as a value is typed', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '4.5' } });
    expect(slider().getAttribute('aria-valuenow')).toBe('4.5');
    expect(lineLeft()).toBe('45%');
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('4.5%');
  });

  it('names an out-of-range value on the field, with the validator’s own message', () => {
    render(<Harness />);
    // The box is described by the lead sentence alone while the value is fine.
    expect(describedTexts(input())).toHaveLength(1);
    expect(describedTexts(input())[0]).toContain(LEAD_START);
    expect(input().getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(input(), { target: { value: '12' } });
    assertFieldAnnouncesError(input().id, RANGE_ERROR);
    // The line holds at the end of the scale; the slider names the error too.
    expect(lineLeft()).toBe('100%');
    expect(describedTexts(slider())).toContain(RANGE_ERROR);
  });

  it('names an out-of-range value before any save, when the page has no field errors yet', () => {
    // Save is disabled while the value is out of range, so the field must name it.
    render(<Harness fieldErrors={{}} />);
    expect(input().getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(input(), { target: { value: '15' } });
    assertFieldAnnouncesError(input().id, RANGE_ERROR);
    expect(describedTexts(slider())).toContain(RANGE_ERROR);

    fireEvent.change(input(), { target: { value: '4' } });
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(describedTexts(input())).not.toContain(RANGE_ERROR);
    expect(screen.queryByText(RANGE_ERROR)).toBeNull();
  });

  it('treats an emptied box as no value, not as 0, and keeps the box empty', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().value).toBe('');
    expect(stateValue()).toBe('NaN');
    expect(describedTexts(input())).toContain('Enter a limit between 0.5% and 10%.');
    expect(slider().getAttribute('aria-valuenow')).toBeNull();
    expect(slider().getAttribute('aria-valuetext')).toBe('Not set');

    // A key on the slider sets it again, from the default.
    fireEvent.keyDown(slider(), { key: 'ArrowUp' });
    expect(input().value).toBe('3.1');
  });
});

describe('a stored value outside the offered range (AC1)', () => {
  /*
    The server takes any value above 0 and up to 100, with any decimals. A campaign
    PATCHed to 25 or 7.25 through the API loads as stored and is accepted as stored:
    refusing it would disable Save for every other edit on the page. Only a NEW
    value has to land in 0.5–10 with one decimal.
  */
  it('loads 25 as stored, without an error, and refuses only a new out-of-range value', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 25 }} />);
    expect(input().value).toBe('25');
    expect(screen.queryByText(RANGE_ERROR)).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBeNull();
    // Pinned at the right-hand end of the fixed scale, its label still the stored value.
    expect(lineLeft()).toBe('100%');
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('25%');

    fireEvent.change(input(), { target: { value: '26' } });
    expect(screen.getByText(RANGE_ERROR)).toBeTruthy();
    // Back to the stored value: accepted again.
    fireEvent.change(input(), { target: { value: '25' } });
    expect(screen.queryByText(RANGE_ERROR)).toBeNull();
  });

  it('keeps the slider’s bounds around the stored value, and does not drop it on an increase key', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 25 }} />);
    expect(slider().getAttribute('aria-valuenow')).toBe('25');
    expect(slider().getAttribute('aria-valuemin')).toBe('0.5');
    expect(slider().getAttribute('aria-valuemax')).toBe('25');

    fireEvent.keyDown(slider(), { key: 'ArrowUp' });
    expect(stateValue()).toBe('25');
    fireEvent.keyDown(slider(), { key: 'End' });
    expect(stateValue()).toBe('25');
    // Towards the range: in at its top.
    fireEvent.keyDown(slider(), { key: 'ArrowDown' });
    expect(stateValue()).toBe('10');
    expect(slider().getAttribute('aria-valuemax')).toBe('10');
  });

  it('widens the minimum for a stored value below the range', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 0.2 }} />);
    expect(slider().getAttribute('aria-valuemin')).toBe('0.2');
    expect(slider().getAttribute('aria-valuemax')).toBe('10');
    fireEvent.keyDown(slider(), { key: 'ArrowDown' });
    expect(stateValue()).toBe('0.2');
    fireEvent.keyDown(slider(), { key: 'ArrowUp' });
    expect(stateValue()).toBe('0.5');
  });

  it('prints a stored 7.25 as 7.25%, not rounded, and accepts it', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 7.25 }} />);
    expect(input().value).toBe('7.25');
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('7.25%');
    expect(screen.getByTestId('abandonment-ceiling-lead').textContent).toContain('more than 7.25% of the calls');
    expect(slider().getAttribute('aria-valuetext')).toBe(
      '7.25%: the campaign pauses when more than 7.25% of answered calls are abandoned',
    );
    expect(input().getAttribute('aria-invalid')).toBeNull();
    // A new two-decimal value is refused.
    fireEvent.change(input(), { target: { value: '7.15' } });
    expect(screen.getByText('Use at most one decimal place, like 3.5.')).toBeTruthy();
  });
});

describe('the section’s error', () => {
  /*
    The pages keep a save's field errors until the next save. A refusal is about the
    value it was given for, so once the value changes the field stops showing it and
    goes back to its own live check.
  */
  const SERVER = 'Must be above 0 and at most 100.';

  it('shows the server’s message for the value it came with, and drops it once the value changes', () => {
    render(<Harness fieldErrors={{ abandonment_ceiling_pct: SERVER }} />);
    assertFieldAnnouncesError(input().id, SERVER);

    fireEvent.change(input(), { target: { value: '4' } });
    expect(screen.queryByText(SERVER)).toBeNull();
    expect(describedTexts(input())).not.toContain(SERVER);
    expect(describedTexts(slider())).not.toContain(SERVER);
    expect(input().getAttribute('aria-invalid')).toBeNull();

    // The live check still names a value of its own that is out of range.
    fireEvent.change(input(), { target: { value: '15' } });
    assertFieldAnnouncesError(input().id, RANGE_ERROR);
    expect(screen.queryByText(SERVER)).toBeNull();
  });
});

describe('a user who cannot write campaigns', () => {
  it('sees the meter as a picture and the box disabled', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 4.5 }} readOnly />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByTestId('abandonment-meter').getAttribute('aria-hidden')).toBe('true');
    const box = screen.getByTestId('abandonment-ceiling-input') as HTMLInputElement;
    expect(box.value).toBe('4.5');
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('4.5%');

    // No handlers: a press on the track moves nothing.
    fireEvent.pointerDown(layOutTrack(), { clientX: 190, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(stateValue()).toBe('4.5');
  });
});

describe('the reference warning', () => {
  it('appears above 3% only, and is not an error', () => {
    render(<Harness />);
    expect(screen.queryByTestId('abandonment-ceiling-warning')).toBeNull();

    fireEvent.keyDown(slider(), { key: 'ArrowRight' }); // 3.1
    const warning = screen.getByTestId('abandonment-ceiling-warning');
    expect(warning.textContent).toBe(
      'Above 3%, the limit most dropped-call rules set. Check the rules that apply to these calls before raising it.',
    );
    expect(input().getAttribute('aria-invalid')).toBeNull();
    // Both controls are described by it, and the box by the lead sentence too.
    expect(describedIds(slider())).toContain(warning.id);
    expect(describedIds(input())).toContain(warning.id);
    expect(describedTexts(input())[0]).toContain(LEAD_START);

    fireEvent.keyDown(slider(), { key: 'ArrowLeft' }); // back to 3
    expect(screen.queryByTestId('abandonment-ceiling-warning')).toBeNull();
    expect(describedIds(input())).toHaveLength(1);
    expect(describedIds(slider())).toHaveLength(1);
  });
});

describe('the read-only meter', () => {
  it('is a picture: no slider, no handlers, hidden from assistive technology', () => {
    render(<AbandonmentMeter ceilingPct={4} ratePct={2.1} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByTestId('abandonment-meter').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('abandonment-meter-ceiling').getAttribute('tabindex')).toBeNull();
    expect(screen.getByTestId('abandonment-meter-ceiling').style.left).toBe('40%');
    expect(parseFloat(screen.getByTestId('abandonment-meter-rate').style.width)).toBeCloseTo(21, 6);
    expect(screen.getByTestId('abandonment-meter-rate').getAttribute('data-over')).toBe('false');
  });

  it('keeps the editable meter on 0–10% whatever scale is passed', () => {
    render(<AbandonmentMeter ceilingPct={5} scaleMaxPct={25} editable={{ onChange: () => undefined, label: 'Abandonment limit' }} />);
    expect(screen.getByTestId('abandonment-meter-ceiling').style.left).toBe('50%');
    const ticks = Array.from(screen.getByTestId('abandonment-meter-scale').children).map((t) => t.textContent);
    expect(ticks).toEqual(['0%', '2%', '4%', '6%', '8%', '10%']);
  });

  it('keeps the number over the track at either end of the scale', () => {
    const { rerender } = render(<AbandonmentMeter ceilingPct={0.5} />);
    expect(screen.getByTestId('abandonment-meter-value').getAttribute('data-align')).toBe('start');
    rerender(<AbandonmentMeter ceilingPct={10} />);
    expect(screen.getByTestId('abandonment-meter-value').getAttribute('data-align')).toBe('end');
    rerender(<AbandonmentMeter ceilingPct={3} />);
    expect(screen.getByTestId('abandonment-meter-value').getAttribute('data-align')).toBe('center');
  });
});
