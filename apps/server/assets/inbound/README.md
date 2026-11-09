# Inbound calls: standard recordings

What an inbound caller hears when the route has no recording of its own for a message
(`docs/inbound.md` §3.4). The server loads them into its clip cache on first use
(`src/agency/inbound/inbound-standard-clips.ts`); the production image copies this directory beside
`dist/` (`docker/Dockerfile`).

| File | Played | Words |
|---|---|---|
| `please-hold.wav` | to a caller who will wait for an agent, when the route has no greeting (then the hold sound) | Thank you for calling. Please hold and we’ll put you through to the next person available. |
| `recording-notice.wav` | before an agent joins a recorded call, when the route tells callers and has no notice recording | This call may be recorded for quality and training purposes. |
| `closed.wav` | out of hours; and instead of the call-back message to a caller who withheld their number or is on DNC | Thank you for calling. We’re closed at the moment. Please call again during our opening hours. Goodbye. |
| `busy.wav` | when the route or the lines are full | Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye. |
| `callback.wav` | to a caller who waited and reached nobody | Thank you for calling. Everyone is busy at the moment, so we’ll call you back as soon as we can. Goodbye. |
| `voicemail-prompt.wav` | before the beep of a voicemail, when the route has no recording for its message | Please leave your name and a short message after the tone, and we’ll call you back. |

The words are `AGENCY_INBOUND_STANDARD_WORDS` (`packages/contracts/src/api/agency/inbound.ts`). A
call answered before anything streams hears the same words spoken by the carrier (`<Speak>`), so
change the words there and regenerate the files together.

## Format

WAV, PCM 16-bit, 8 kHz, mono, a plain 44-byte header (no metadata chunks). Any PCM16 WAV plays (a
different rate or stereo is converted when it is loaded), but 8 kHz mono needs no work per call.

## Replacing them

The files are drop-in replaceable by professionally recorded ones: keep the file names, say the
same words (or change the words in the contract to match), and keep them short. Nothing else
changes.

## Regenerating them

`scripts/generate-inbound-clips.ts` synthesises each from its words with Piper and converts it with
ffmpeg (3 dB of headroom, 0.2 s lead-in, 0.5 s trailing pause). It is not run in CI or at build
time. From `apps/server`, with Piper installed in a virtualenv (`pip install piper-tts`) and ffmpeg
on the path:

```bash
pnpm tsx scripts/generate-inbound-clips.ts \
  --piper /path/to/venv/bin/piper \
  --model /path/to/en-gb-southern_english_female-low.onnx
```

## Voice, licence and attribution

Synthesised with [Piper](https://github.com/rhasspy/piper) using the voice
`en_GB-southern_english_female-low` (British English, one female speaker; Piper voice files
`en-gb-southern_english_female-low.onnx` and `.onnx.json`). The voice model is trained on the
"Crowdsourced high-quality UK and Ireland English Dialect speech data set" (OpenSLR SLR83,
http://www.openslr.org/83/, by Google), licensed **CC BY-SA 4.0**
(https://creativecommons.org/licenses/by-sa/4.0/). Attribution: speech dataset © Google, CC BY-SA
4.0; voice model by the Piper project (rhasspy). These recordings are derived from that voice and are
shared under the same licence.
