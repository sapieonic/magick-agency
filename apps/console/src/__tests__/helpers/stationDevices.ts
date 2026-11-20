import { vi } from 'vitest';

/**
 * A microphone that opens, for page tests of the agent station: Start of day checks the
 * microphone when it opens (spec 01), and jsdom has no `navigator.mediaDevices`, which the check
 * reads as a microphone that cannot work (screen 01b). Call in `beforeEach`; `restore` in
 * `afterEach`. Files that stub `mediaDevices` themselves (the audio tests) do not need it.
 */
export function stubStationMicrophone(labels: string[] = []): { restore: () => void; getUserMedia: ReturnType<typeof vi.fn> } {
  const had = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => labels.map((label) => ({ kind: 'audioinput', label, deviceId: label, groupId: '' })),
    },
  });
  return {
    getUserMedia,
    restore: () => {
      if (had) Object.defineProperty(navigator, 'mediaDevices', had);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    },
  };
}
