import { describe, it, expect, afterEach, beforeAll } from 'vitest';
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

/**
 * The abandonment limit as the supervisor meets it: the meter whose line is the
 * slider, and the number box beside it, inside the Behaviour section. The
 * rounding and the bounds are the pure module's (`utils/abandonmentCeiling.test.ts`);
 * these show that the drag, each key and the typed value reach them, and that the
 * two controls stay one value.
 */

/*
  A DOM without `PointerEvent` would turn `fireEvent.pointerDown` into a bare
  `Event` with no `clientX`, and the drag would silently test nothing. Polyfilled
  as a MouseEvent (which carries the coordinates) only where it is missing.
*/
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
  }
});

afterEach(cleanup);

/** The section's behaviour group with the page's own validator feeding its errors live. */
function Harness({ campaign }: { campaign?: Partial<AgencyCampaign> }) {
  const [state, setState] = useState<CampaignConfigState>(() =>
    configFromCampaign({ id: 'camp-1', name: 'Collections', status: 'draft', ...campaign }),
  );
  return (
    <>
      <CampaignBehaviourSection
        state={state}
        onChange={setState}
        fieldErrors={validateConfig(state)}
        layout="plain"
        include={['behaviour']}
      />
      <output data-testid="state-ceiling">{String(state.abandonmentCeilingPct)}</output>
    </>
  );
}

/**
 * As the builder and settings pages drive it: `fieldErrors` stays empty until a
 * save attempt, and Save is disabled while the value is out of range, so the field
 * must name the problem on its own.
 */
function PageHarness() {
  const [state, setState] = useState<CampaignConfigState>(() =>
    configFromCampaign({ id: 'camp-1', name: 'Collections', status: 'draft' }),
  );
  return (
    <CampaignBehaviourSection
      state={state}
      onChange={setState}
      fieldErrors={{}}
      layout="plain"
      include={['behaviour']}
    />
  );
}

const slider = () => screen.getByRole('slider', { name: 'Abandonment limit' });
const input = () => screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement;
const stateValue = () => screen.getByTestId('state-ceiling').textContent;
const lineLeft = () => (screen.getByTestId('abandonment-meter-ceiling') as HTMLElement).style.left;

/** Lay the track out at 200px wide from x = 100, so x = 100 + 20·p is p% on the scale. */
function layOutTrack() {
  const track = slider().parentElement as HTMLElement;
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

    fireEvent.pointerMove(hit, { clientX: 152, pointerId: 1, pointerType: 'mouse' });
    expect(stateValue()).toBe('2.6');

    // Past either end of the track the line holds at the bound.
    fireEvent.pointerMove(hit, { clientX: 900, pointerId: 1, pointerType: 'mouse' });
    expect(stateValue()).toBe('10');
    fireEvent.pointerMove(hit, { clientX: -50, pointerId: 1, pointerType: 'mouse' });
    expect(stateValue()).toBe('0.5');

    fireEvent.pointerUp(hit, { clientX: -50, pointerId: 1, pointerType: 'mouse' });
    // Released: a move no longer drags.
    fireEvent.pointerMove(hit, { clientX: 260, pointerId: 1, pointerType: 'mouse' });
    expect(stateValue()).toBe('0.5');
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
    expect(input().getAttribute('aria-describedby')).toBeNull();

    fireEvent.change(input(), { target: { value: '12' } });
    const describedBy = input().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('Set the limit between 0.5% and 10%.');
    // The line holds at the end of the scale; the slider names the error too.
    expect(lineLeft()).toBe('100%');
    expect(slider().getAttribute('aria-describedby')).toContain(describedBy!);
  });

  it('names an out-of-range value before any save, when the page has no field errors yet', () => {
    render(<PageHarness />);
    expect(input().getAttribute('aria-invalid')).toBeNull();

    fireEvent.change(input(), { target: { value: '15' } });
    const describedBy = input().getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe('Set the limit between 0.5% and 10%.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(slider().getAttribute('aria-describedby')).toContain(describedBy!);

    fireEvent.change(input(), { target: { value: '4' } });
    expect(input().getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('Set the limit between 0.5% and 10%.')).toBeNull();
  });

  it('treats an emptied box as no value, not as 0, and keeps the box empty', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '' } });
    expect(input().value).toBe('');
    expect(stateValue()).toBe('NaN');
    const describedBy = input().getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe('Enter a limit between 0.5% and 10%.');
    expect(slider().getAttribute('aria-valuenow')).toBeNull();
    expect(slider().getAttribute('aria-valuetext')).toBe('Not set');

    // A key on the slider sets it again, from the default.
    fireEvent.keyDown(slider(), { key: 'ArrowUp' });
    expect(input().value).toBe('3.1');
  });

  it('loads a stored value outside the offered range as stored, and names it', () => {
    render(<Harness campaign={{ abandonment_ceiling_pct: 25 }} />);
    expect(input().value).toBe('25');
    expect(screen.getByText('Set the limit between 0.5% and 10%.')).toBeTruthy();
  });
});

describe('the reference warning', () => {
  it('appears above 3% only, and is not an error', () => {
    render(<Harness />);
    expect(screen.queryByTestId('abandonment-ceiling-warning')).toBeNull();

    fireEvent.keyDown(slider(), { key: 'ArrowRight' }); // 3.1
    expect(screen.getByTestId('abandonment-ceiling-warning').textContent).toBe(
      'Above 3%, the limit most dropped-call rules set. Check the rules that apply to these calls before raising it.',
    );
    expect(input().getAttribute('aria-describedby')).toBeNull();

    fireEvent.keyDown(slider(), { key: 'ArrowLeft' }); // back to 3
    expect(screen.queryByTestId('abandonment-ceiling-warning')).toBeNull();
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

  it('turns the rate red at the ceiling', () => {
    render(<AbandonmentMeter ceilingPct={3} ratePct={3} />);
    expect(screen.getByTestId('abandonment-meter-rate').getAttribute('data-over')).toBe('true');
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
