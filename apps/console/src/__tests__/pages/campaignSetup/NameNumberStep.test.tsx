import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NameNumberStep, type NameNumberStepProps } from '../../../pages/campaigns/agency/setup/NameNumberStep';
import { SERVICE_CARRIER, carrierOptions, type CarrierChoice } from '../../../utils/agencyCarriers';

const CRED_A = '11111111-1111-4111-8111-111111111111';
const TENANT_A: CarrierChoice = { telephony_provider: 'plivo', telephony_credential_id: CRED_A };

vi.mock('../../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+914048501001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        telephony_credential_id: null,
        label: 'Hyderabad office',
        is_default: true,
      },
      {
        phone_number_id: 'pn-2',
        phone_number: '+914048501002',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        telephony_credential_id: null,
        label: null,
        is_default: false,
      },
      {
        phone_number_id: 'pn-3',
        phone_number: '+14155550104',
        provider_name: 'plivo',
        provider_display_name: 'Plivo',
        telephony_credential_id: CRED_A,
        label: 'Own A',
        is_default: false,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+914048501001',
  }),
}));

const SERVICE_LISTED = { ...SERVICE_CARRIER, label: null, status: 'active' as const };
const ONE_CARRIER = carrierOptions([SERVICE_LISTED], null);
const TWO_CARRIERS = carrierOptions([SERVICE_LISTED, { ...TENANT_A, label: 'Acme main', status: 'active' as const }], null);

function renderStep(over: Partial<NameNumberStepProps> = {}) {
  const props: NameNumberStepProps = {
    mode: 'create',
    name: '',
    onName: vi.fn(),
    carrierChoices: ONE_CARRIER,
    carrier: SERVICE_CARRIER,
    onCarrier: vi.fn(),
    callerIds: [],
    onCallerIds: vi.fn(),
    ...over,
  };
  render(<NameNumberStep {...props} />);
  return props;
}

afterEach(cleanup);

describe('NameNumberStep (CS1, step 1)', () => {
  it('reads as the mock-up: the card, its helper, the name and the numbers as cards', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: 'Name & number' })).toBeTruthy();
    expect(screen.getByText('Give it a name your team will recognise, and pick the number customers will see.')).toBeTruthy();
    expect(screen.getByLabelText(/Campaign name/)).toBeTruthy();
    const group = screen.getByRole('group', { name: /Customers will see this number/ });
    expect(group).toBe(screen.getByTestId('caller-id-cards'));
    // Two numbers on the service's account; the tenant's own is on another carrier.
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('value'))).toEqual(['+914048501001', '+914048501002']);
    const first = screen.getByRole('checkbox', { name: '+91 40485 01001' });
    expect(first.closest('label')?.textContent).toContain('Hyderabad office');
    expect(screen.getByText(/Pick more than one to rotate numbers\. Most campaigns need one\./)).toBeTruthy();
    // CS5: no language choices.
    expect(screen.queryByText(/language/i)).toBeNull();
  });

  it('sends the name and the numbers out, and holds no state of its own', () => {
    const props = renderStep({ name: 'Collections' });
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections, November' } });
    expect(props.onName).toHaveBeenCalledWith('Collections, November');
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).value).toBe('Collections');

    fireEvent.click(screen.getByRole('checkbox', { name: '+91 40485 01002' }));
    expect(props.onCallerIds).toHaveBeenCalledWith(['+914048501002']);
  });

  it('focuses the name on New campaign only', () => {
    renderStep({ mode: 'create' });
    expect(document.activeElement).toBe(screen.getByLabelText(/Campaign name/));
    cleanup();
    renderStep({ mode: 'edit', name: 'Collections' });
    expect(document.activeElement).not.toBe(screen.getByLabelText(/Campaign name/));
  });

  it('says what is wrong under its field', () => {
    renderStep({ nameError: 'A campaign with this name already exists.', callerIdsError: 'Pick at least one number.' });
    const input = screen.getByLabelText(/Campaign name/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby')!.split(' ')[1]!;
    expect(document.getElementById(errorId)?.textContent).toBe('A campaign with this name already exists.');
    expect(screen.getByText('Pick at least one number.')).toBeTruthy();
  });

  it('shows the carrier only when there is a choice, and locks it with its notice', () => {
    renderStep();
    expect(screen.queryByLabelText(/Carrier/)).toBeNull();
    cleanup();

    const props = renderStep({ carrierChoices: TWO_CARRIERS });
    const select = screen.getByLabelText(/Carrier/) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: TWO_CARRIERS[1]!.key } });
    expect(props.onCarrier).toHaveBeenCalledWith(TENANT_A);
    cleanup();

    renderStep({
      carrierChoices: TWO_CARRIERS,
      carrierLocked: true,
      carrierNotice: 'The draft is saved on this carrier. Change it in the campaign’s Settings.',
    });
    expect((screen.getByLabelText(/Carrier/) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('The draft is saved on this carrier. Change it in the campaign’s Settings.')).toBeTruthy();
  });

  it('offers the chosen carrier’s numbers', () => {
    renderStep({ carrierChoices: TWO_CARRIERS, carrier: TENANT_A, carrierLabel: 'Acme main' });
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('value'))).toEqual(['+14155550104']);
  });
});
