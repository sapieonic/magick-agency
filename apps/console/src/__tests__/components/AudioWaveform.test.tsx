import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AudioWaveform } from '../../components/audio/AudioWaveform';

// Mock AudioContext with class syntax
class MockAudioContext {
  async decodeAudioData() {
    return { getChannelData: () => new Float32Array(1000).fill(0.5) };
  }
  async close() {}
}

vi.stubGlobal('AudioContext', MockAudioContext);

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
}));

function getPlayBtn(container: HTMLElement) {
  return container.querySelector('[class*="playBtn"]') as HTMLButtonElement;
}

function getMuteBtn(container: HTMLElement) {
  return container.querySelector('[class*="muteBtn"]') as HTMLButtonElement;
}

describe('AudioWaveform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders play button with aria-label', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const btn = getPlayBtn(container);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Play');
  });

  it('renders mute button with aria-label', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const btn = getMuteBtn(container);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Mute');
  });

  it('renders time display', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const time = container.querySelector('[class*="time"]');
    expect(time?.textContent).toContain('0:00');
  });

  it('renders waveform slider with aria attributes', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const slider = container.querySelector('[role="slider"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute('aria-label')).toBe('Audio timeline');
    expect(slider?.getAttribute('aria-valuemin')).toBe('0');
  });

  it('renders audio element with correct src', () => {
    const { container } = render(<AudioWaveform src="blob:test-url" />);
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:test-url');
    expect(audio?.getAttribute('preload')).toBe('metadata');
  });

  it('calls play on audio when play button clicked', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const playBtn = getPlayBtn(container);
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'play', {
      value: vi.fn().mockResolvedValue(undefined),
    });

    fireEvent.click(playBtn);
    expect(audio.play).toHaveBeenCalled();
  });

  it('toggles mute state on audio element', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    const muteBtn = getMuteBtn(container);
    const audio = container.querySelector('audio')!;

    fireEvent.click(muteBtn);
    expect(audio.muted).toBe(true);

    // After muting, the aria-label should change
    expect(muteBtn.getAttribute('aria-label')).toBe('Unmute');

    fireEvent.click(muteBtn);
    expect(audio.muted).toBe(false);
    expect(muteBtn.getAttribute('aria-label')).toBe('Mute');
  });

  it('calls onTimeUpdate callback on audio timeupdate', () => {
    const onTimeUpdate = vi.fn();
    const { container } = render(
      <AudioWaveform src="blob:test" onTimeUpdate={onTimeUpdate} />
    );
    const audio = container.querySelector('audio')!;

    Object.defineProperty(audio, 'currentTime', { value: 5, writable: true });
    Object.defineProperty(audio, 'duration', { value: 60, writable: true });
    fireEvent.timeUpdate(audio);

    expect(onTimeUpdate).toHaveBeenCalledWith(5);
  });

  it('renders expected DOM structure', () => {
    const { container } = render(<AudioWaveform src="blob:test" />);
    expect(container.querySelector('[class*="container"]')).not.toBeNull();
    expect(container.querySelector('[class*="controls"]')).not.toBeNull();
    expect(container.querySelector('[class*="waveform"]')).not.toBeNull();
  });
});
