import { describe, it, expect } from 'vitest';
import {
  callbacksGapNote,
  keptOnTimeSub,
  notDialledSub,
  overdueNowSub,
} from '../../utils/agency/insights/copy';

/** The Callbacks tab's words for its two families of figures (range by booked time, now by contact). */
describe('callbacks copy', () => {
  it('gives "Kept on time" a sentence for every case, never a bare dash', () => {
    expect(keptOnTimeSub({ kept_on_time: 0, kept_late: 0, missed: 0 }, null)).toBe('None dialled or missed yet');
    expect(keptOnTimeSub({ kept_on_time: 1, kept_late: 1, missed: 0 }, null)).toBe('Too few yet for a share (2 callbacks dialled or missed)');
    expect(keptOnTimeSub({ kept_on_time: 40, kept_late: 10, missed: 6 }, '71.4%')).toBe('71.4% of those dialled or missed');
  });

  it('names the range figures by booked time and the now figure by contact', () => {
    expect(notDialledSub({ pending_future: 0, pending_due: 16 })).toBe('0 not due yet · 16 past their booked time');
    expect(overdueNowSub({ open_due_today: 5 })).toBe('Contacts waiting on one, whatever the range · 5 more due later today');
  });

  it('explains the gap between the two overdue figures only when there is one', () => {
    expect(callbacksGapNote({ pending_due: 14, open_overdue: 14 })).toBeNull();
    expect(callbacksGapNote({ pending_due: 16, open_overdue: 14 })).toMatch(/^Why two overdue figures/);
    expect(callbacksGapNote({ pending_due: 2, open_overdue: 14 })).not.toBeNull();
  });
});
