import { useRef, useState, useEffect, useCallback, type CSSProperties } from 'react';
import { Play, Pause, Volume2, VolumeX } from 'lucide-react';
import styles from './AudioWaveform.module.css';

interface AudioWaveformProps {
  src: string;
  /** Callback when playback time changes — useful for transcript sync */
  onTimeUpdate?: (currentTime: number) => void;
}

const BAR_COUNT = 80;
const BAR_WIDTH = 3;
const BAR_GAP = 2;

/**
 * Decodes audio buffer and extracts normalized amplitude bars for visualization.
 */
async function extractWaveformData(src: string, bars: number): Promise<number[]> {
  const response = await fetch(src);
  const arrayBuffer = await response.arrayBuffer();
  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / bars);
  const amplitudes: number[] = [];

  for (let i = 0; i < bars; i++) {
    let sum = 0;
    const start = i * samplesPerBar;
    for (let j = start; j < start + samplesPerBar && j < channelData.length; j++) {
      sum += Math.abs(channelData[j]!);
    }
    amplitudes.push(sum / samplesPerBar);
  }

  // Normalize to 0..1
  const max = Math.max(...amplitudes, 0.01);
  return amplitudes.map(a => a / max);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioWaveform({ src, onTimeUpdate }: AudioWaveformProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hoverBar, setHoverBar] = useState<number | null>(null);

  // Extract waveform data from audio
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    extractWaveformData(src, BAR_COUNT)
      .then(data => {
        if (!cancelled) {
          setWaveform(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Fallback: generate random-ish waveform
          setWaveform(Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.9));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [src]);

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      onTimeUpdate?.(audio.currentTime);
    };
    const handleDurationChange = () => setDuration(audio.duration);
    const handleEnded = () => setPlaying(false);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, [onTimeUpdate]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
  }, [playing]);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(!muted);
  }, [muted]);

  const seekToBar = useCallback((barIndex: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const time = (barIndex / BAR_COUNT) * duration;
    audio.currentTime = time;
    setCurrentTime(time);
  }, [duration]);

  const progress = duration > 0 ? currentTime / duration : 0;
  const playedBars = Math.floor(progress * BAR_COUNT);

  const waveformWidth = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <div className={styles.container}>
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.playBtn}
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>

        <span className={styles.time}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <button
          type="button"
          className={styles.muteBtn}
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>

      <div
        ref={waveformRef}
        className={styles.waveform}
        style={{ '--waveform-width': `${waveformWidth}px` } as CSSProperties}
        role="slider"
        aria-label="Audio timeline"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(currentTime)}
      >
        {loading ? (
          <div className={styles.loadingBars}>
            {Array.from({ length: BAR_COUNT }, (_, i) => (
              <div
                key={i}
                className={styles.bar}
                style={{
                  height: `${20 + Math.random() * 30}%`,
                  opacity: 0.15,
                }}
              />
            ))}
          </div>
        ) : (
          waveform.map((amp, i) => {
            const isPlayed = i < playedBars;
            const isHovered = hoverBar !== null && i <= hoverBar;
            const minHeight = 8;
            const maxHeight = 48;
            const height = minHeight + amp * (maxHeight - minHeight);

            return (
              <div
                key={i}
                className={`${styles.bar} ${isPlayed ? styles.barPlayed : ''} ${isHovered && !isPlayed ? styles.barHover : ''}`}
                style={{ height: `${height}px` }}
                onMouseEnter={() => setHoverBar(i)}
                onMouseLeave={() => setHoverBar(null)}
                onClick={() => seekToBar(i)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
