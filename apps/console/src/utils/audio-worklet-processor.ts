import g711Source from './alaw8/g711.js?raw';

/**
 * The capture worklet: microphone samples in, one station-socket media frame out per
 * 20 ms, in the socket's format (contracts `AgencyStationMediaFormat`):
 *
 *  - `alaw8`: whole 160-byte G.711 A-law 8 kHz frames, low-passed and decimated from the
 *    16 kHz capture context (`AlawUplinkEncoder` in `alaw8/g711.js`);
 *  - `pcm16`: 640-byte PCM16 16 kHz frames, the fallback (`Pcm16UplinkFramer`).
 *
 * Each frame is posted as `{ format, data }` with `data` transferred, so the main thread
 * never has to guess a frame's format from its length (a 640-byte PCM16 frame is also
 * four whole A-law frames). The format is chosen at construction
 * (`processorOptions.format`) and can be switched over the port (`{ format }`) without
 * rebuilding the graph: the station falls back to `pcm16` on a server that refuses
 * `alaw8`, possibly mid-call. A switch starts the new encoder from clean state.
 *
 * Served from a `blob:` URL, as it always has been: no build or deployment change.
 */
export const STATION_CAPTURE_PROCESSOR = 'station-capture-processor';

/** What the worklet posts for each frame. */
export interface CapturedFrameMessage {
  format: 'pcm16' | 'alaw8';
  data: ArrayBuffer;
}

const processorSource = `
class StationCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.format = null;
    this.encoder = null;
    this.emit = (data) => this.port.postMessage({ format: this.format, data }, [data]);
    this.setFormat(opts.format === 'alaw8' ? 'alaw8' : 'pcm16');
    this.port.onmessage = (e) => {
      const next = e.data && e.data.format;
      if (next === 'alaw8' || next === 'pcm16') this.setFormat(next);
    };
  }

  setFormat(format) {
    if (format === this.format) return;
    try {
      // \`sampleRate\` is the worklet scope's global: the capture context's rate.
      this.encoder = format === 'alaw8' ? new AlawUplinkEncoder(sampleRate) : new Pcm16UplinkFramer();
      this.format = format;
    } catch (err) {
      // A rate A-law cannot be made from (the hook refuses those before building the
      // node). Never left without an encoder: the frames say which format they are.
      if (this.encoder === null) {
        this.encoder = new Pcm16UplinkFramer();
        this.format = 'pcm16';
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel) this.encoder.push(channel, this.emit);
    return true;
  }
}

registerProcessor('${STATION_CAPTURE_PROCESSOR}', StationCaptureProcessor);
`;

/**
 * The worklet module's full source: the DSP file's text, then the processor.
 *
 * `export` is stripped from the DSP text so the result is also a valid script body (the
 * unit tests evaluate it as one); in the worklet, a module, the declarations are the
 * same either way.
 */
export function getWorkletSource(): string {
  return `${g711Source.replace(/^export /gm, '')}\n${processorSource}`;
}

let blobUrl: string | null = null;

export function getWorkletUrl(): string {
  if (!blobUrl) {
    const blob = new Blob([getWorkletSource()], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob);
  }
  return blobUrl;
}
