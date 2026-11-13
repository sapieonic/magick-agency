import { describe, expect, it } from 'vitest';
import { pushTokenOf } from '../../../src/models/push-device.model.js';

// `agency_push_devices` (0036, Mode B): the token a send uses is the platform's own.
describe('pushTokenOf', () => {
  it('Android sends to the FCM token, iOS to the VoIP token; never the other platform\'s', () => {
    expect(pushTokenOf({ platform: 'android', fcm_token: 'fcm', voip_token: 'voip' })).toBe('fcm');
    expect(pushTokenOf({ platform: 'ios', fcm_token: 'fcm', voip_token: 'voip' })).toBe('voip');
    expect(pushTokenOf({ platform: 'android', fcm_token: null, voip_token: 'voip' })).toBeNull();
    expect(pushTokenOf({ platform: 'ios', fcm_token: 'fcm', voip_token: null })).toBeNull();
  });
});
