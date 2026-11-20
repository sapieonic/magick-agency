import { useCallback, useEffect, useRef, useState } from 'react';
import { headsetCheckFrom, microphoneCheckFrom } from '../../../utils/agency/stationDevices';
import type { DeviceChecks } from '../../../utils/agency/stationView';

/**
 * Start of day's microphone and headset checks (spec 01, 01b; §5.1 "Changed: run it when the
 * screen opens, not on the button").
 *
 * The microphone check asks for the microphone and lets it go at once: a probe, never held, so
 * nothing listens between calls. It builds no audio context, so it needs no click (Start work's
 * own preflight warms the audio on its click, as before). The headset check reads the browser's
 * device list after that, when it has labels.
 *
 * Runs while `active` (the agent is not working yet) and again on `recheck` (01b's Check again).
 */
export function useDeviceChecks(active: boolean): DeviceChecks & { recheck: () => void } {
  const [microphone, setMicrophone] = useState<DeviceChecks['microphone']>('checking');
  const [headset, setHeadset] = useState<DeviceChecks['headset']>('unknown');
  const [round, setRound] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!active) return undefined;
    const mine = ++seq.current;
    let live = true;
    const current = () => live && mine === seq.current;
    setMicrophone('checking');
    const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!devices?.getUserMedia) {
      // An insecure page (plain http) has no `mediaDevices` at all: the microphone cannot work.
      setMicrophone('problem');
      setHeadset('unknown');
      return () => {
        live = false;
      };
    }
    devices
      .getUserMedia({ audio: true })
      .then(async (stream) => {
        stream.getTracks().forEach((track) => track.stop());
        if (!current()) return;
        setMicrophone('ok');
        try {
          const list = devices.enumerateDevices ? await devices.enumerateDevices() : null;
          if (current()) setHeadset(headsetCheckFrom(list));
        } catch {
          if (current()) setHeadset('unknown');
        }
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setMicrophone(microphoneCheckFrom(err));
        setHeadset('unknown');
      });
    return () => {
      live = false;
    };
  }, [active, round]);

  const recheck = useCallback(() => setRound((r) => r + 1), []);
  return { microphone, headset, recheck };
}
