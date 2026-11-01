import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CallFieldsForm } from '../../components/softphone/CallFieldsForm';
import type { AgencyCallField, AgencyCallFieldValues } from '../../types/softphone';

/**
 * A yes/no call detail nobody has answered is not "No": a required one blocks
 * Save until it is answered, and reading "No" the agent could not tell why.
 */

afterEach(cleanup);

const CONSENT: AgencyCallField = { key: 'consent', label: 'Consent given', type: 'boolean', required: true };

function renderForm(values: AgencyCallFieldValues) {
  const onChange = vi.fn();
  render(<CallFieldsForm fields={[CONSENT]} values={values} errors={{}} disabled={false} onChange={onChange} />);
  return { onChange, toggle: screen.getByTestId('call-field-consent') as HTMLInputElement };
}

describe('a yes/no call detail', () => {
  it('unanswered says "Not answered", to the eye and to a screen reader', () => {
    const { toggle } = renderForm({});
    expect(screen.getByText('Not answered')).toBeTruthy();
    expect(screen.queryByText('No')).toBeNull();
    expect(toggle.checked).toBe(false);
    const describedBy = (toggle.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain('Not answered');
  });

  it('a null value is unanswered too', () => {
    renderForm({ consent: null });
    expect(screen.getByText('Not answered')).toBeTruthy();
  });

  it('answered No says No, and answered Yes says Yes', () => {
    renderForm({ consent: false });
    expect(screen.getByText('No')).toBeTruthy();
    expect(screen.queryByText('Not answered')).toBeNull();
    cleanup();
    renderForm({ consent: true });
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('turning it on answers Yes', () => {
    const { toggle, onChange } = renderForm({});
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith('consent', true);
  });
});
