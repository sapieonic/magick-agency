import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallerIdPicker } from '../../pages/agency/CallerIdPicker';
import { SERVICE_CARRIER, type CarrierChoice } from '../../utils/agencyCarriers';

/**
 * The excluded-numbers sentence, rendered.
 *
 * It shipped reading *"…dial through Swaronly."* — a missing space, not a bad
 * provider name. The alias sat at the end of a source line with `only.` wrapped
 * onto the next, and JSX discards the leading newline and indent of a text node,
 * so no space survived between the two.
 *
 * That is a class of bug no type check and no unit test over a `*Copy.ts` module
 * can see, because the string does not exist until the JSX is rendered — the two
 * halves are separate nodes. It reached production on two screens (campaign
 * Settings and the builder, which share this component) because nothing rendered
 * this sentence.
 *
 * So this file asserts the composed output rather than any constant.
 */

const CRED_A = '11111111-1111-4111-8111-111111111111';
const CRED_B = '22222222-2222-4222-8222-222222222222';
const TENANT_A: CarrierChoice = { telephony_provider: 'plivo', telephony_credential_id: CRED_A };

const numbers = [
  {
    phone_number_id: 'pn-1',
    phone_number: '+912200000001',
    provider_name: 'voicelink',
    provider_display_name: 'VoiceLink',
    telephony_credential_id: null,
    label: 'Outbound 1',
    is_default: true,
  },
  {
    phone_number_id: 'pn-2',
    phone_number: '+912200000002',
    provider_name: 'vobiz',
    provider_display_name: 'VoBiz',
    label: 'Other 1',
    is_default: false,
  },
  {
    phone_number_id: 'pn-3',
    phone_number: '+912200000003',
    provider_name: 'vobiz',
    provider_display_name: 'VoBiz',
    label: 'Other 2',
    is_default: false,
  },
  {
    phone_number_id: 'pn-4',
    phone_number: '+14155550104',
    provider_name: 'plivo',
    provider_display_name: 'Plivo',
    telephony_credential_id: CRED_A,
    label: 'Own A',
    is_default: false,
  },
  {
    phone_number_id: 'pn-5',
    phone_number: '+14155550105',
    provider_name: 'plivo',
    provider_display_name: 'Plivo',
    telephony_credential_id: CRED_B,
    label: 'Own B',
    is_default: false,
  },
];

vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: numbers,
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));

const shown = () => screen.queryAllByRole('checkbox').map((box) => box.closest('label')?.textContent ?? '');

describe('the excluded-numbers sentence', () => {
  it('keeps a space between the carrier name and the word after it', () => {
    const { container } = render(<CallerIdPicker selected={[]} onChange={vi.fn()} carrier={SERVICE_CARRIER} />);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Swaronly/);
    expect(text).toMatch(/dials through Swar only/);
  });

  it('counts and agrees in number with the numbers it excluded', () => {
    render(<CallerIdPicker selected={[]} onChange={vi.fn()} carrier={SERVICE_CARRIER} />);

    // Four of the five are on another carrier account.
    expect(screen.getByText(/4 numbers on other carriers are not shown/)).toBeTruthy();
  });
});

describe('filtering by the campaign’s carrier account', () => {
  it('offers only the service’s own numbers for the service carrier: a same-carrier tenant number is not one', () => {
    render(<CallerIdPicker selected={[]} onChange={vi.fn()} carrier={SERVICE_CARRIER} />);
    expect(shown()).toEqual([expect.stringContaining('+912200000001')]);
  });

  it('offers only the numbers synced from THAT credential for a tenant’s own account', () => {
    render(<CallerIdPicker selected={[]} onChange={vi.fn()} carrier={TENANT_A} carrierLabel="Acme main" />);
    expect(shown()).toEqual([expect.stringContaining('+14155550104')]);
    // Named by alias and label, never by the carrier's identifier or vendor name.
    expect(screen.getByText(/dials through Pravah \(Acme main\) only/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/plivo/i);
  });

  it('says so when the carrier account has no numbers on this account', () => {
    render(
      <CallerIdPicker
        selected={[]}
        onChange={vi.fn()}
        carrier={{ telephony_provider: 'plivo', telephony_credential_id: '33333333-3333-4333-8333-333333333333' }}
        carrierLabel="Acme spare"
      />,
    );
    expect(screen.getByText('No numbers on Pravah (Acme spare) are assigned to this account.')).toBeTruthy();
    expect(shown()).toEqual([]);
    // PL15: number assignment is support's to do, not the tenant's administrator's.
    expect(document.body.textContent).toMatch(/Contact support to have one assigned\./);
    expect(document.body.textContent).not.toMatch(/administrator/i);
  });
});

describe('a change of carrier', () => {
  it('drops the selected numbers that are not on the new carrier account, and only on a change', () => {
    const onChange = vi.fn();
    const selected = ['+912200000001', '+14155550104', '+19999999999'];
    const { rerender } = render(<CallerIdPicker selected={selected} onChange={onChange} carrier={SERVICE_CARRIER} />);
    // Mounting with a stored pool never prunes it: the pool is the campaign's as saved.
    expect(onChange).not.toHaveBeenCalled();

    // A new object naming the same account is not a change.
    rerender(<CallerIdPicker selected={selected} onChange={onChange} carrier={{ ...SERVICE_CARRIER }} />);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<CallerIdPicker selected={selected} onChange={onChange} carrier={TENANT_A} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['+14155550104']);
  });

  it('leaves the selection alone when every number fits the new account', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CallerIdPicker selected={['+14155550104']} onChange={onChange} carrier={SERVICE_CARRIER} />);
    rerender(<CallerIdPicker selected={['+14155550104']} onChange={onChange} carrier={TENANT_A} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('a selected number the account no longer lists on this carrier account', () => {
  it('is shown as its own row with a Remove button, and counted', () => {
    const onChange = vi.fn();
    render(<CallerIdPicker selected={['+14155550104', '+14155550199']} onChange={onChange} carrier={TENANT_A} carrierLabel="Acme main" />);
    // Mounting never prunes it.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('caller-id-unavailable').textContent).toMatch(/\+14155550199.*No longer available/);
    expect(screen.getByText(/^2 selected\./)).toBeTruthy();
    screen.getByRole('button', { name: 'Remove +14155550199' }).click();
    expect(onChange).toHaveBeenCalledWith(['+14155550104']);
  });

  it('is shown with the empty state too, when nothing on the account is available', () => {
    const onChange = vi.fn();
    render(
      <CallerIdPicker
        selected={['+14155550199']}
        onChange={onChange}
        carrier={{ telephony_provider: 'plivo', telephony_credential_id: '33333333-3333-4333-8333-333333333333' }}
        carrierLabel="Acme spare"
      />,
    );
    expect(screen.getByText('No numbers on Pravah (Acme spare) are assigned to this account.')).toBeTruthy();
    screen.getByRole('button', { name: 'Remove +14155550199' }).click();
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
