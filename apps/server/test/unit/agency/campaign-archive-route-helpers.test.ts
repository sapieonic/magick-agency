import { describe, it, expect } from 'vitest';
import { readArchiveActor } from '../../../src/api/routes/agency-campaigns/archive.js';
import { ACTOR_NAME_MAX } from '../../../src/api/routes/agency-campaigns/lifecycle.js';

/** The internal archive route's actor reader (AR5). Which statuses may be archived is the contract's, tested there. */

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('readArchiveActor', () => {
  it('reads a UUID id and a trimmed name', () => {
    expect(readArchiveActor({ actor_user_id: ` ${ID} `, actor_name: '  Asha Menon ' })).toEqual({ user_id: ID, name: 'Asha Menon' });
  });

  it('keeps an id with no name, or a blank one, as id-only', () => {
    expect(readArchiveActor({ actor_user_id: ID })).toEqual({ user_id: ID, name: null });
    expect(readArchiveActor({ actor_user_id: ID, actor_name: '   ' })).toEqual({ user_id: ID, name: null });
  });

  it('cuts an over-long name to the column, never refusing the archive for it', () => {
    expect(readArchiveActor({ actor_user_id: ID, actor_name: 'x'.repeat(400) })?.name).toHaveLength(ACTOR_NAME_MAX);
  });

  it('records nobody for no body, a missing, non-string or non-UUID id (the column is a UUID)', () => {
    for (const body of [undefined, null, {}, { actor_user_id: 42 }, { actor_user_id: 'u-1' }, { actor_user_id: `${ID}x` }]) {
      expect(readArchiveActor(body), JSON.stringify(body)).toBeNull();
    }
  });
});
