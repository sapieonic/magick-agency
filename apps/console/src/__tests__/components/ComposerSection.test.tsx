import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ComposerSection } from '../../pages/campaigns/components/ComposerSection';

afterEach(() => cleanup());

describe('ComposerSection', () => {
  it('renders the step number, title, helper and children', () => {
    const { container } = render(
      <ComposerSection step={2} title="Who you call" helper="Pick recipients">
        <div data-testid="body-child">child content</div>
      </ComposerSection>,
    );

    expect(screen.getByText('Who you call')).toBeTruthy();
    expect(screen.getByText('Pick recipients')).toBeTruthy();
    expect(screen.getByTestId('body-child').textContent).toBe('child content');
    // The badge shows the raw step number when not complete.
    const badge = container.querySelector('[class*="badge"]');
    expect(badge?.textContent).toBe('2');
  });

  it('shows the step number (no check icon) when not complete', () => {
    const { container } = render(
      <ComposerSection step={1} title="Step one" helper="Helper one">
        <span>x</span>
      </ComposerSection>,
    );
    const badge = container.querySelector('[class*="badge"]')!;
    // No SVG check icon while incomplete.
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge.textContent).toBe('1');
    // Complete modifier class is absent.
    expect(badge.className).not.toMatch(/badgeComplete/);
  });

  it('shows a completion tick (and complete modifier) when complete is true', () => {
    const { container } = render(
      <ComposerSection step={3} title="Done" helper="All set" complete>
        <span>x</span>
      </ComposerSection>,
    );
    const badge = container.querySelector('[class*="badge"]')!;
    // The lucide Check renders an svg; the step number is not shown.
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge.textContent).not.toContain('3');
    expect(badge.className).toMatch(/badgeComplete/);
  });

  it('defaults complete to false when the prop is omitted', () => {
    const { container } = render(
      <ComposerSection step={5} title="Default" helper="h">
        <span>x</span>
      </ComposerSection>,
    );
    const badge = container.querySelector('[class*="badge"]')!;
    expect(badge.textContent).toBe('5');
    expect(badge.querySelector('svg')).toBeNull();
  });
});

describe('a section that is not part of a numbered sequence', () => {
  /*
    `AgencyCampaignSettingsPage` reuses these cards for their title, helper and
    framing, and it has no steps. It rendered a card badged "3" and another
    badged "4" with no 1, 2 or 5 on the page, because `CampaignBehaviourSection`
    hardcoded the numbers the CAMPAIGN COMPOSER gives those two sections.
  */
  it('renders no badge ELEMENT when no step number is given', () => {
    const { container } = render(
      <ComposerSection title="Calling hours" helper="When this campaign is allowed to dial.">
        <p>body</p>
      </ComposerSection>,
    );

    expect(screen.getByText('Calling hours')).toBeTruthy();
    expect(screen.getByText('When this campaign is allowed to dial.')).toBeTruthy();

    /*
      Asserted on the ELEMENT, not on the text, and mutation testing is why.

      The first version of this test only checked that no digit appeared
      anywhere. That passes for the bug it was written to catch: an
      unconditionally rendered badge whose content is `{step}` with `step`
      undefined renders an EMPTY circle — a visible badge with no digit in it —
      so a text assertion sees nothing wrong. The empty badge is the whole defect.
    */
    expect(container.querySelector('[class*="badge"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('still badges a numberless section that is complete', () => {
    // "Satisfied" is a fact about the section itself, unlike its position in a
    // sequence, so a tick still earns the badge.
    const { container } = render(
      <ComposerSection title="Calling hours" helper="When it may dial." complete>
        <p>body</p>
      </ComposerSection>,
    );

    expect(container.querySelector('svg')).toBeTruthy();
  });
});
