import { describe, expect, it } from 'vitest';
import { clientHeaders, ORIGINATOR_HEADER } from '../src/clientHeaders';

// The wire format the server's X-Client parser reads (apps/server/src/utils/client-header.ts).
describe('clientHeaders', () => {
  it('sends the originator and X-Client: <originator>/<version>', () => {
    expect(clientHeaders('magick-agency-console', '0.29.0')).toEqual({
      [ORIGINATOR_HEADER]: 'magick-agency-console',
      'X-Client': 'magick-agency-console/0.29.0',
    });
    expect(ORIGINATOR_HEADER).toBe('x-mgkvc-originator');
  });
});
