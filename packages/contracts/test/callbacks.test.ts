import { describe, expect, it } from 'vitest';
import { AgencyApi } from '../src/index';
import {
  AGENCY_CALLBACK_SOURCES,
  AGENCY_CALLBACKS_DUE_VALUES,
  AGENCY_CALLBACKS_PAGE_DEFAULT,
  AGENCY_CALLBACKS_PAGE_MAX,
  AGENCY_CALLBACKS_QUERY_ERROR_CODE,
} from '../src/api/agency/callbacks';

/**
 * SNAPSHOTS, written out by hand, of the account's callbacks list's vocabularies (decision LF22):
 * its query and rows. The lists are held equal to their unions at type level (`AllListed`).
 */
describe('the account\'s callbacks list (LF22)', () => {
  it('its query vocabulary, page sizes and refusal code', () => {
    expect([...AGENCY_CALLBACKS_DUE_VALUES]).toEqual(['overdue', 'today']);
    expect([...AGENCY_CALLBACK_SOURCES]).toEqual(['outcome', 'inbound']);
    expect({ AGENCY_CALLBACKS_PAGE_DEFAULT, AGENCY_CALLBACKS_PAGE_MAX }).toEqual({ AGENCY_CALLBACKS_PAGE_DEFAULT: 50, AGENCY_CALLBACKS_PAGE_MAX: 200 });
    expect(AGENCY_CALLBACKS_QUERY_ERROR_CODE).toBe('invalid_callbacks_query');
  });

  it('is on the console wire namespace', () => {
    expect(AgencyApi.AGENCY_CALLBACKS_QUERY_ERROR_CODE).toBe('invalid_callbacks_query');
  });
});
