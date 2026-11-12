import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StationIdentity } from '../../components/agency/StationIdentity';

describe('StationIdentity', () => {
  it('shows the signed-in name and the campaign as the subline', () => {
    render(
      <StationIdentity
        user={{ display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null }}
        subline="Renewals"
      />,
    );
    const chip = screen.getByTestId('station-identity');
    expect(chip.textContent).toContain('Asha Kumar');
    expect(chip.textContent).toContain('Renewals');
    expect(chip.textContent).toContain('AK');
  });

  it('falls back to email when there is no display name', () => {
    render(
      <StationIdentity
        user={{ display_name: null, email: 'asha@example.com', avatar_url: null }}
        subline="Renewals"
      />,
    );
    expect(screen.getByTestId('station-identity').textContent).toContain('asha@example.com');
  });

  it('shows the same initials as the profile menu: letters only, the email without a name', () => {
    const { rerender } = render(
      <StationIdentity user={{ display_name: 'Manas (Dev)', email: 'm@example.com', avatar_url: null }} subline="Renewals" />,
    );
    expect(screen.getByTestId('station-identity').textContent).toBe('MDManas (Dev)Renewals');
    rerender(<StationIdentity user={{ display_name: null, email: 'asha@example.com', avatar_url: null }} subline="Renewals" />);
    expect(screen.getByTestId('station-identity').textContent).toBe('ASasha@example.comRenewals');
  });
});
