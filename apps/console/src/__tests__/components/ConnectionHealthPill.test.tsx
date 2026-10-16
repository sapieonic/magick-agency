import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ConnectionHealthPill, CONNECTION_LABEL } from '../../components/agency/ConnectionHealthPill';
import type { StationConnection } from '../../hooks/useAgencyStation';

afterEach(cleanup);

const pill = () => screen.getByText(/./, { selector: 'span[data-state]' });

describe('ConnectionHealthPill — one word per connection state', () => {
  it.each<[StationConnection, string]>([
    ['idle', 'Connecting'],
    ['connecting', 'Connecting'],
    ['open', 'Connected'],
    ['reconnecting', 'Reconnecting'],
    ['superseded', 'Moved to another window'],
    ['session_gone', 'Session ended'],
    // Named, not left to a fallback: a stopped console must never read
    // "Connecting".
    ['disconnected', 'Disconnected'],
  ])('%s reads "%s"', (connection, label) => {
    render(<ConnectionHealthPill connection={connection} missedPings={0} />);
    expect(pill().textContent).toBe(label);
    expect(pill().getAttribute('data-state')).toBe(connection);
    expect(CONNECTION_LABEL[connection]).toBe(label);
  });

  it('says "Weak connection" from two missed pings, and not at one', () => {
    // One missed ping is not an alarm — a single 10s gap is normal on wifi.
    const { rerender } = render(<ConnectionHealthPill connection="open" missedPings={1} />);
    expect(pill().textContent).toBe('Connected');
    rerender(<ConnectionHealthPill connection="open" missedPings={2} />);
    expect(pill().textContent).toBe('Weak connection');
    // Only an open socket can be weak; the others name their own state.
    rerender(<ConnectionHealthPill connection="reconnecting" missedPings={5} />);
    expect(pill().textContent).toBe('Reconnecting');
  });
});
