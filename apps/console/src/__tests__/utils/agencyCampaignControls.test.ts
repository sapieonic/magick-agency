import { describe, it, expect } from 'vitest';
import {
  agencyCampaignControls,
  isLifecycleActionEnabled,
  showsPauseInFlightNote,
  PAUSE_IN_FLIGHT_NOTE,
} from '../../utils/agencyCampaignControls';

/**
 * Which lifecycle controls a state offers, and why it refuses the rest
 *.
 */

describe('agencyCampaignControls', () => {
  it('offers start and stop on a draft', () => {
    expect(agencyCampaignControls('draft').map((c) => c.action)).toEqual(['start', 'stop']);
    expect(agencyCampaignControls('draft').every((c) => c.disabledReason === null)).toBe(true);
  });

  it('offers pause and stop while running, resume and stop while paused', () => {
    expect(agencyCampaignControls('running').map((c) => c.action)).toEqual(['pause', 'stop']);
    expect(agencyCampaignControls('paused').map((c) => c.action)).toEqual(['resume', 'stop']);
  });

  it('shows resume on a STOPPING campaign, disabled, with the reason', () => {
    // The case the ticket names. `stop` answers 200 with `stopping` and the
    // pacing leader writes `stopped` once in-flight calls drain, so a supervisor
    // sits on this state for as long as the longest live call — long enough to
    // reach for Resume and deserve an answer instead of a missing button.
    const resume = agencyCampaignControls('stopping').find((c) => c.action === 'resume');
    expect(resume).toBeTruthy();
    expect(resume!.disabledReason).toMatch(/can’t be resumed/i);
    expect(resume!.disabledReason).toMatch(/still finishing/i);
  });

  it('refuses a second stop on a stopping campaign rather than hiding it', () => {
    const stop = agencyCampaignControls('stopping').find((c) => c.action === 'stop');
    expect(stop!.disabledReason).toBe('Already stopping.');
  });

  it('offers nothing on a terminal campaign', () => {
    // Four disabled buttons under a finished campaign is noise pretending to be
    // information, and the API has no transition out of either state.
    expect(agencyCampaignControls('stopped')).toEqual([]);
    expect(agencyCampaignControls('completed')).toEqual([]);
  });

  it('offers nothing for a status this build has never heard of', () => {
    // A state whose transitions we cannot know is one where every button is a
    // guess that fails at the API — the exact outcome this guards against.
    expect(agencyCampaignControls('quiescing')).toEqual([]);
  });

  it('never returns a live control without a matching action', () => {
    for (const status of ['draft', 'running', 'paused', 'stopping']) {
      for (const control of agencyCampaignControls(status)) {
        expect(['start', 'pause', 'resume', 'stop']).toContain(control.action);
      }
    }
  });

  it('tells a click whether the action is actually live for this status', () => {
    expect(isLifecycleActionEnabled('draft', 'start')).toBe(true);
    expect(isLifecycleActionEnabled('draft', 'pause')).toBe(false);
    expect(isLifecycleActionEnabled('running', 'start')).toBe(false);
    expect(isLifecycleActionEnabled('running', 'pause')).toBe(true);
    expect(isLifecycleActionEnabled('paused', 'resume')).toBe(true);
    expect(isLifecycleActionEnabled('paused', 'start')).toBe(false);
    // Present but refused — a click must not POST.
    expect(isLifecycleActionEnabled('stopping', 'resume')).toBe(false);
    expect(isLifecycleActionEnabled('stopping', 'stop')).toBe(false);
    expect(isLifecycleActionEnabled('stopped', 'start')).toBe(false);
    expect(isLifecycleActionEnabled('quiescing', 'start')).toBe(false);
  });
});

describe('pause in-flight note', () => {
  it('says plainly that connected calls are not dropped', () => {
    expect(PAUSE_IN_FLIGHT_NOTE).toMatch(/new calls only/i);
    expect(PAUSE_IN_FLIGHT_NOTE).toMatch(/keep going/i);
    expect(PAUSE_IN_FLIGHT_NOTE).toMatch(/nobody is cut off/i);
  });

  it('shows while running and while paused, and nowhere else', () => {
    // On a paused campaign it is doing its second job: explaining why "Live now"
    // is not zero yet.
    expect(showsPauseInFlightNote('running')).toBe(true);
    expect(showsPauseInFlightNote('paused')).toBe(true);
    expect(showsPauseInFlightNote('draft')).toBe(false);
    expect(showsPauseInFlightNote('stopping')).toBe(false);
    expect(showsPauseInFlightNote('completed')).toBe(false);
  });
});
