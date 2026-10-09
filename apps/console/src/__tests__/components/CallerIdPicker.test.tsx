import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallerIdPicker } from '../../pages/agency/CallerIdPicker';

/**
 * The excluded-numbers sentence, rendered.
 *
 * It shipped reading *"…dial through Swaronly."* — a missing space, not a bad
 * provider name. `{AGENCY_PROVIDER_ALIAS}` sat at the end of a source line with
 * `only.` wrapped onto the next, and JSX discards the leading newline and indent
 * of a text node, so no space survived between the two.
 *
 * That is a class of bug no type check and no unit test over a `*Copy.ts` module
 * can see, because the string does not exist until the JSX is rendered — the two
 * halves are separate nodes. It reached production on two screens (campaign
 * Settings and the builder, which share this component) because nothing rendered
 * this sentence.
 *
 * So this file asserts the composed output rather than any constant.
 */

const numbers = [
  {
    phone_number_id: 'pn-1',
    phone_number: '+912200000001',
    provider_name: 'voicelink',
    provider_display_name: 'VoiceLink',
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

describe('the excluded-numbers sentence', () => {
  it('keeps a space between the provider name and the word after it', () => {
    const { container } = render(<CallerIdPicker selected={[]} onChange={vi.fn()} />);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Swaronly/);
    expect(text).toMatch(/dial through Swar only/);
  });

  it('counts and agrees in number with the numbers it excluded', () => {
    render(<CallerIdPicker selected={[]} onChange={vi.fn()} />);

    // Two of the three are on another provider.
    expect(screen.getByText(/2 numbers on other providers are not shown/)).toBeTruthy();
  });
});
