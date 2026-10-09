# Audio decode fixtures

Real, committed audio — deliberately not mocks. The decode layer is a pair of
child processes over untrusted bytes; the only thing worth asserting is what the
actual tools do with actual files, and both tools have surprising behaviour
(see the routing comment in `src/audio/decode.ts`).

All are 0.5 s tones, a few KB each.

| File | Contents | Purpose |
|---|---|---|
| `mono-440-44100.mp3` | 440 Hz mono, 44.1 kHz | mpg123 happy path |
| `stereo-440-880-44100.mp3` | 440 Hz L / 880 Hz R, 44.1 kHz | mpg123 `-m` downmix (both tones must survive) |
| `mono-440-16000.wav` | 440 Hz mono, 16 kHz | sndfile happy path, non-44.1k rate preserved |
| `stereo-440-880-22050.wav` | 440 Hz L / 880 Hz R, 22.05 kHz | **the trap** — sndfile does NOT downmix; JS must |
| `mono-440-16000.ogg` | 440 Hz mono Vorbis, 16 kHz | OGG via sndfile |
| `stereo-440-880-44100.ogg` | 440 Hz L / 880 Hz R Vorbis, 44.1 kHz | OGG stereo → JS downmix; also has a `LIST` chunk before `data`, which is why the WAV parser walks chunks |
| `mono-440-44100.m4a` | 440 Hz mono AAC | must be rejected — no ffmpeg |

## Regenerating

Requires `ffmpeg` (fixtures only — the service does not use it) and
`sndfile-convert`. The stereo files use `join` rather than `amerge` so each
channel carries a *different* tone: a downmix bug that drops a channel is then
detectable, which a same-tone-both-sides fixture could not catch.

```sh
cd test/fixtures/audio

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
  -ac 1 -codec:a libmp3lame -b:a 64k mono-440-44100.mp3

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
       -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=44100" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" \
  -codec:a libmp3lame -b:a 64k stereo-440-880-44100.mp3

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=16000" \
  -ac 1 -c:a pcm_s16le mono-440-16000.wav

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=22050" \
       -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=22050" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" \
  -c:a pcm_s16le stereo-440-880-22050.wav

# This ffmpeg build has no libvorbis; sndfile-convert encodes Vorbis instead
# (and its output carries the LIST chunk the parser must skip).
sndfile-convert -vorbis mono-440-16000.wav        mono-440-16000.ogg
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
       -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=44100" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" \
  -c:a pcm_s16le /tmp/st44.wav
sndfile-convert -vorbis /tmp/st44.wav stereo-440-880-44100.ogg

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
  -ac 1 -c:a aac_at mono-440-44100.m4a   # -c:a aac on builds without aac_at
```
