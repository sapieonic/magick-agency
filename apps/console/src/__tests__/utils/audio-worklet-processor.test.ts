import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

  // ─── worklet code content ───────────────────────────────────────────────────

  it('embeds PCM16Processor class in the Blob code', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:code-check';
    });

    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();

    const code = await capturedBlob!.text();
    expect(code).toContain('PCM16Processor');
  });

  it('registers the processor with registerProcessor', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:register-check';
    });

    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();

    const code = await capturedBlob!.text();
    expect(code).toContain('registerProcessor');
    expect(code).toContain('pcm16-processor');
  });

  it('worklet code extends AudioWorkletProcessor', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:extends-check';
    });

    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();

    const code = await capturedBlob!.text();
    expect(code).toContain('AudioWorkletProcessor');
  });

  it('worklet code includes a process method', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj) => {
      capturedBlob = obj as Blob;
      return 'blob:process-check';
    });

    const { getWorkletUrl } = await import('../../utils/audio-worklet-processor');
    getWorkletUrl();

    const code = await capturedBlob!.text();
    expect(code).toContain('process(');
  });
});
