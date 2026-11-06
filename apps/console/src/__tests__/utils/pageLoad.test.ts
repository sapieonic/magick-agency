import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadPage } from '../../utils/pageLoad';

/**
 * A tenant or account switch is a full page load (B26), and an ASSIGN: a new
 * history entry, so the back button returns to the account the user came from.
 * `location.replace` would drop it.
 */
describe('loadPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns the URL, a load that pushes a history entry', () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});

    loadPage('/t/t-a/a/acct-2/station?campaign=c-1');

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/t/t-a/a/acct-2/station?campaign=c-1');
    expect(replace).not.toHaveBeenCalled();
  });
});
