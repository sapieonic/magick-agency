import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWorkletSource,
  STATION_CAPTURE_PROCESSOR,
  type CapturedFrameMessage,
} from '../../utils/audio-worklet-processor';
import { AlawUplinkEncoder, Pcm16UplinkFramer } from '../../utils/alaw8/g711.js';

// audio-worklet-processor.ts has module-level state (`blobUrl`).
// We reset modules before each test so the singleton cache is cleared,
// then dynamically import to get a fresh module instance.

describe('getWorkletUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── return value ───────────────────────────────────────────────────────────

  it('returns a string', async () => {
    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    expect(typeof getWorkletUrl()).toBe('string');
  });

  it('returns the mocked blob URL', async () => {
    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    expect(getWorkletUrl()).toBe('blob:mock-url');
  });

  // ─── caching (singleton) ────────────────────────────────────────────────────

  it('returns the same URL on every subsequent call', async () => {
    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    const first = getWorkletUrl();
    const second = getWorkletUrl();
    const third = getWorkletUrl();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('calls URL.createObjectURL only once regardless of call count', async () => {
    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();
    getWorkletUrl();
    getWorkletUrl();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  // ─── Blob construction ──────────────────────────────────────────────────────

  it('passes a Blob to URL.createObjectURL', async () => {
    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();
    const [arg] = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown];
    expect(arg).toBeInstanceOf(Blob);
  });

  it('creates the Blob with application/javascript MIME type', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:mime-check';
    });

    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();

    expect(capturedBlob).toBeDefined();
    expect(capturedBlob!.type).toBe('application/javascript');
  });

  it('the Blob holds exactly the assembled worklet source', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:code-check';
    });

    const mod = await import('../../utils/audio-worklet-processor');
    mod.getWorkletUrl();

    expect(await capturedBlob!.text()).toBe(mod.getWorkletSource());
  });
});

/**
 * **The worklet as the browser runs it.**
 *
 * The source is evaluated as a script body with nothing in scope but the three things
 * an `AudioWorkletGlobalScope` provides (`AudioWorkletProcessor`, `registerProcessor`,
 * `sampleRate`) and the language built-ins. So this proves the module is
 * self-contained (a reference to anything in the app bundle throws here, as it would
 * in the worklet) and then drives the registered processor with 128-sample render
 * quanta, the way the audio thread does.
 */
interface LoadedProcessor {
  process(inputs: Float32Array[][]): boolean;
  port: { posted: Array<{ message: CapturedFrameMessage; transfer: unknown[] }>; deliver(data: unknown): void };
}

function loadWorklet(rate: number, format?: 'pcm16' | 'alaw8') {
  const registered: Array<{ name: string; ctor: new (options?: unknown) => LoadedProcessor }> = [];
  class FakeAudioWorkletProcessor {
    port = {
      posted: [] as Array<{ message: CapturedFrameMessage; transfer: unknown[] }>,
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(message: CapturedFrameMessage, transfer: unknown[] = []) {
        this.posted.push({ message, transfer });
      },
      deliver(data: unknown) {
        this.onmessage?.({ data });
      },
    };
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', getWorkletSource())(
    FakeAudioWorkletProcessor,
    (name: string, ctor: new (options?: unknown) => LoadedProcessor) => registered.push({ name, ctor }),
    rate,
  );
  const options = format ? { processorOptions: { format } } : undefined;
  return { registered, processor: registered.length ? new registered[0]!.ctor(options) : null };
}

function sine(hz: number, rate: number, samples: number): Float32Array {
  const x = new Float32Array(samples);
  for (let i = 0; i < samples; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / rate);
  return x;
}

/** Run `x` through the processor one render quantum at a time. */
function render(p: LoadedProcessor, x: Float32Array): void {
  for (let i = 0; i < x.length; i += 128) expect(p.process([[x.subarray(i, i + 128)]])).toBe(true);
}

describe('the capture worklet', () => {
  it('registers one processor, under the name the capture hook builds', () => {
    const { registered } = loadWorklet(16000);
    expect(registered.map((r) => r.name)).toEqual([STATION_CAPTURE_PROCESSOR]);
    expect(STATION_CAPTURE_PROCESSOR).toBe('station-capture-processor');
  });

  it('carries no `export` (stripped, so the source is valid as a script as well as a module)', () => {
    expect(getWorkletSource()).not.toMatch(/^export /m);
  });

  it('alaw8: one 160-byte A-law frame per 20 ms, transferred, the remainder carried across quanta', () => {
    const { processor } = loadWorklet(16000, 'alaw8');
    const p = processor!;
    // Three quanta are 192 bytes at 8 kHz: one frame out, 32 bytes held.
    render(p, sine(1000, 16000, 384));
    expect(p.port.posted).toHaveLength(1);
    // Two more make 320 bytes in all: the second frame completes, nothing held.
    render(p, sine(1000, 16000, 256));
    expect(p.port.posted).toHaveLength(2);

    for (const { message, transfer } of p.port.posted) {
      expect(message.format).toBe('alaw8');
      expect(message.data).toBeInstanceOf(ArrayBuffer);
      expect(message.data.byteLength).toBe(160);
      // Transferred, not copied: the 50 Hz path allocates once per frame and no more.
      expect(transfer).toEqual([message.data]);
    }
  });

  it('alaw8: one second of capture is fifty frames, byte for byte what the encoder module makes', () => {
    const { processor } = loadWorklet(16000, 'alaw8');
    const x = sine(1000, 16000, 16000);
    render(processor!, x);
    const posted = processor!.port.posted.map((m) => new Uint8Array(m.message.data));
    expect(posted).toHaveLength(50);

    const expected: Uint8Array[] = [];
    const enc = new AlawUplinkEncoder(16000);
    for (let i = 0; i < x.length; i += 128) enc.push(x.subarray(i, i + 128), (b) => expected.push(new Uint8Array(b)));
    expect(posted).toEqual(expected);
  });

  it('alaw8 from an 8 kHz context: passed through, still whole 160-byte frames', () => {
    const { processor } = loadWorklet(8000, 'alaw8');
    render(processor!, sine(1000, 8000, 8000));
    expect(processor!.port.posted).toHaveLength(50);
    for (const { message } of processor!.port.posted) expect(message.data.byteLength).toBe(160);
  });

  it('pcm16 (the default): 640-byte PCM16 frames, as the console has always sent', () => {
    const { processor } = loadWorklet(16000);
    const x = sine(1000, 16000, 16000);
    render(processor!, x);
    const posted = processor!.port.posted;
    expect(posted).toHaveLength(50);
    for (const { message } of posted) {
      expect(message.format).toBe('pcm16');
      expect(message.data.byteLength).toBe(640);
    }
    const expected: ArrayBuffer[] = [];
    const framer = new Pcm16UplinkFramer();
    for (let i = 0; i < x.length; i += 128) framer.push(x.subarray(i, i + 128), (b) => expected.push(b));
    expect(posted.map((m) => new Uint8Array(m.message.data))).toEqual(expected.map((b) => new Uint8Array(b)));
  });

  it('switches format over its port without being rebuilt, and tags every frame', () => {
    const { processor } = loadWorklet(16000, 'alaw8');
    const p = processor!;
    render(p, sine(1000, 16000, 640));
    expect(p.port.posted.map((m) => m.message.format)).toEqual(['alaw8', 'alaw8']);

    p.port.deliver({ format: 'pcm16' });
    render(p, sine(1000, 16000, 640));
    const after = p.port.posted.slice(2);
    expect(after.map((m) => m.message.format)).toEqual(['pcm16', 'pcm16']);
    for (const { message } of after) expect(message.data.byteLength).toBe(640);

    // Anything that is not a format is ignored.
    p.port.deliver({ format: 'opus' });
    p.port.deliver(null);
    render(p, sine(1000, 16000, 320));
    expect(p.port.posted.at(-1)!.message.format).toBe('pcm16');
  });

  it('keeps running with no input (a disconnected source) and posts nothing', () => {
    const { processor } = loadWorklet(16000, 'alaw8');
    expect(processor!.process([[]])).toBe(true);
    expect(processor!.process([])).toBe(true);
    expect(processor!.port.posted).toHaveLength(0);
  });

  it('never leaves itself without an encoder: an alaw8 it cannot make falls back to pcm16, tagged so', () => {
    const { processor } = loadWorklet(44100, 'alaw8');
    render(processor!, sine(1000, 44100, 640));
    expect(processor!.port.posted.map((m) => m.message.format)).toEqual(['pcm16', 'pcm16']);
  });
});
