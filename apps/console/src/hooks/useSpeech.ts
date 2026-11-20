import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AS13: Read aloud and Speak a note, with the browser's own speech and no server.
 *
 * Read aloud: `speechSynthesis` reads a tile's label, in an Indian English voice when the browser
 * has one (`en-IN`), else any English voice, else the default. Speak a note: the browser's speech
 * recognition (`SpeechRecognition`, or Chrome's `webkitSpeechRecognition`) fills the note; where
 * the browser has none the button is hidden (`dictationAvailable` false), never shown dead.
 */

/** The voice Read aloud uses: `en-IN` first, then any English, then the browser's default. */
export function pickVoice(voices: readonly Pick<SpeechSynthesisVoice, 'lang'>[]): number {
  const lang = (v: Pick<SpeechSynthesisVoice, 'lang'>) => v.lang.replace('_', '-').toLowerCase();
  const indian = voices.findIndex((v) => lang(v) === 'en-in');
  if (indian >= 0) return indian;
  return voices.findIndex((v) => lang(v).startsWith('en'));
}

export function useReadAloud(): { available: boolean; say: (text: string) => void } {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  const available = Boolean(synth && typeof window.SpeechSynthesisUtterance === 'function');
  const say = useCallback(
    (text: string) => {
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
      const utterance = new window.SpeechSynthesisUtterance(text);
      const voices = synth.getVoices?.() ?? [];
      const index = pickVoice(voices);
      if (index >= 0) {
        utterance.voice = voices[index]!;
        utterance.lang = voices[index]!.lang;
      } else {
        utterance.lang = 'en-IN';
      }
      utterance.rate = 0.95;
      // A new press replaces what is still being read rather than queueing behind it.
      synth.cancel();
      synth.speak(utterance);
    },
    [synth],
  );
  return { available, say };
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Speak a note: each finished phrase is handed to `onText`, which appends it to the note.
 * Stops by itself when the browser stops listening, and on unmount.
 */
export function useDictation(onText: (text: string) => void): {
  available: boolean;
  listening: boolean;
  toggle: () => void;
} {
  const Ctor = recognitionCtor();
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recRef.current) {
      stop();
      return;
    }
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-IN';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (event) => {
      const results = Array.from(event.results);
      const last = results[results.length - 1];
      const text = last?.[0]?.transcript?.trim();
      if (text) onTextRef.current(text);
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    rec.onerror = () => {
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, [Ctor, stop]);

  useEffect(() => () => recRef.current?.stop(), []);

  return { available: Ctor !== null, listening, toggle };
}
