import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { DispositionCatalogEditor } from '../../pages/campaigns/agency/DispositionCatalogEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import type { AgencyDispositionEntry } from '../../types/agency-campaign';

/**
 * The outcome editor's "Allows override" group: a campaign feature, so off by
 * default (the soft phone's settings reuse this editor and must not offer it),
 * hidden where the outcome suppresses or ends the contact, and dropped from the
 * entry when the outcome is switched to one that does.
 */

function Harness({ initial, overrides }: { initial: AgencyDispositionEntry[]; overrides?: boolean }) {
  const [dispositions, setDispositions] = useState(initial);
  const errors = useConfigFieldErrors({});
  return (
    <>
      <DispositionCatalogEditor
        dispositions={dispositions}
        onChange={setDispositions}
        errors={errors}
        overrides={overrides}
      />
      <pre data-testid="state">{JSON.stringify(dispositions)}</pre>
    </>
  );
}

const PTP: AgencyDispositionEntry = { code: 'ptp', label: 'Promise to pay' };

afterEach(() => cleanup());

describe('Allows override', () => {
  it('is not offered unless asked for (the soft phone catalog)', () => {
    render(<Harness initial={[PTP]} />);
    expect(screen.queryByTestId('override-group-0')).toBeNull();
  });

  it('edits each part, keeps the override object minimal, and removes it when all are off', () => {
    render(<Harness initial={[PTP]} overrides />);
    const group = screen.getByTestId('override-group-0');
    fireEvent.click(within(group).getByLabelText('May dial before the next scheduled time'));
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0].override).toEqual({ retry_delay: true });
    fireEvent.click(within(group).getByLabelText('Extra attempts past the limit'));
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0].override)
      .toEqual({ extra_attempts: 1, retry_delay: true });
    fireEvent.click(within(group).getByLabelText('Extra attempts past the limit'));
    fireEvent.click(within(group).getByLabelText('May dial before the next scheduled time'));
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0]).not.toHaveProperty('override');
  });

  it('is hidden on an outcome that ends or stops calling the contact, and the grant goes with it', () => {
    render(<Harness initial={[{ ...PTP, override: { calling_hours: true } }]} overrides />);
    expect(screen.getByTestId('override-group-0')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Ends this contact/));
    expect(screen.queryByTestId('override-group-0')).toBeNull();
    expect(JSON.parse(screen.getByTestId('state').textContent!)[0]).not.toHaveProperty('override');
  });

  it('never offers Do Not Call as an override', () => {
    render(<Harness initial={[PTP]} overrides />);
    const group = screen.getByTestId('override-group-0');
    expect(within(group).getAllByRole('checkbox')).toHaveLength(3);
    expect(group.textContent).not.toMatch(/do not call|dnc/i);
  });
});
